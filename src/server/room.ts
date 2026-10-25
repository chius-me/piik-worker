import { DurableObject } from "cloudflare:workers";
import {
  iceSchema,
  type Auth,
  type Command,
  type Joined,
  type MediaReply,
  type RpcResult,
  type RpcValue,
  type Snapshot,
  type Track,
} from "../shared/protocol";
import { AppError, digest, equalHash, fail, failure, token } from "./errors";
import { Sfu, type SfuReply } from "./sfu";

type Member = {
  id: string;
  name: string;
  role: "host" | "viewer";
  hash: string;
  active: boolean;
  lastSeen: number;
  reason?: "KICKED" | "LEFT" | "EXPIRED";
};
type Session = {
  attemptId: string;
  owner: string;
  id?: string;
  shareId: string;
  phase: "opening" | "pending" | "ready" | "retired";
  mids: string[];
  tracks: Track[];
  reply?: MediaReply;
  created: number;
  uncertain: boolean;
  probeUntil: number;
  retryAt: number;
  failures: number;
};
export type RoomState = {
  roomId: string;
  hostId: string;
  inviteHash: string;
  expiresAt: number;
  ended: boolean;
  revision: number;
  alarmAt: number;
  members: Record<string, Member>;
  sessions: Session[];
  tickets: Record<string, { memberId: string; expiresAt: number }>;
};
const LEASE_MS = 120_000;
const NEGOTIATION_MS = 30_000;
const CLEANUP_PROBE_MS = 60_000;

export class Room extends DurableObject<Env> {
  private state?: RoomState;
  private readonly sfu: Sfu;
  private operations = new Map<
    string,
    { key: string; promise: Promise<unknown> }
  >();
  private busySessions = new Set<Session>();
  private cleaning?: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sfu = new Sfu(env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS room_state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)",
    );
    const row = ctx.storage.sql
      .exec<{ data: string }>("SELECT data FROM room_state WHERE id=1")
      .toArray()[0];
    if (row) this.state = JSON.parse(row.data) as RoomState;
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async invoke(command: Command): Promise<RpcResult> {
    try {
      return { ok: true, value: await this.execute(command) };
    } catch (error) {
      return failure(error);
    }
  }

  private async execute(command: Command): Promise<RpcValue> {
    if (command.action === "create") return this.create(command.input);
    if (command.action === "join") return this.join(command.input);
    const member = await this.authorize(command.auth);
    const state = this.requireState();
    switch (command.action) {
      case "snapshot":
        member.lastSeen = Date.now();
        this.save();
        return this.snapshot();
      case "ice":
        return this.iceServers();
      case "ticket": {
        const ticket = token();
        const hash = await digest(ticket);
        this.assertActive(member);
        for (const [key, ticket] of Object.entries(state.tickets))
          if (ticket.memberId === member.id) delete state.tickets[key];
        state.tickets[hash] = {
          memberId: member.id,
          expiresAt: Date.now() + 30_000,
        };
        this.save();
        return { ticket };
      }
      case "invite":
        this.host(member);
        {
          const hash = await digest(command.input.inviteToken);
          this.assertActive(member);
          state.inviteHash = hash;
          this.changed();
          return this.snapshot();
        }
      case "kick": {
        this.host(member);
        const hash = await digest(command.input.inviteToken);
        this.assertActive(member);
        const target = state.members[command.input.memberId];
        if (!target || target.role !== "viewer")
          fail(400, "TARGET_INVALID", "只能移出本房间的观众。");
        state.inviteHash = hash;
        this.removeMember(target, "KICKED");
        this.changed();
        await this.cleanup();
        return this.snapshot();
      }
      case "stop":
        this.host(member);
        this.retireAll();
        this.changed();
        await this.cleanup();
        return this.snapshot();
      case "leave":
        if (member.role === "host") this.retireAll();
        else this.removeMember(member, "LEFT");
        this.changed();
        await this.cleanup();
        return this.snapshot();
      case "end":
        this.host(member);
        state.ended = true;
        this.retireAll();
        this.changed();
        this.closeSockets();
        await this.cleanup();
        return this.snapshot();
      case "publish":
        this.host(member);
        return this.mediaOperation(
          member,
          `publish:${command.input.attemptId}`,
          () => this.publish(member, command.input),
        );
      case "subscribe":
        if (member.role !== "viewer")
          fail(403, "VIEWER_ONLY", "房主通过本地预览观看共享。");
        return this.mediaOperation(
          member,
          `subscribe:${command.input.attemptId}`,
          () => this.subscribe(member, command.input),
        );
      case "answer":
        return this.mediaOperation(
          member,
          `answer:${command.input.attemptId}`,
          () => this.answer(member, command.input),
        );
      case "ready": {
        const session = this.currentSession(member, command.input.attemptId);
        if (session.phase !== "ready" && session.phase !== "pending")
          fail(409, "MEDIA_STALE", "媒体连接已被替换。", true);
        if (member.role === "viewer" && session.phase === "pending")
          fail(409, "ANSWER_REQUIRED", "请先完成媒体协商。", true);
        session.phase = "ready";
        session.reply = undefined;
        member.lastSeen = Date.now();
        this.changed();
        return this.snapshot();
      }
    }
  }

  private async create(
    input: Extract<Command, { action: "create" }>["input"],
  ): Promise<Joined> {
    const [hash, inviteHash] = await Promise.all([
      digest(input.memberToken),
      digest(input.inviteToken),
    ]);
    if (this.state) {
      const member = await this.authorize({
        memberId: input.memberId,
        token: input.memberToken,
      });
      this.host(member);
      return this.joined(member);
    }
    const member: Member = {
      id: input.memberId,
      name: input.name,
      hash,
      role: "host",
      active: true,
      lastSeen: Date.now(),
    };
    this.state = {
      roomId: input.roomId,
      hostId: member.id,
      inviteHash,
      expiresAt: Date.now() + 24 * 60 * 60_000,
      ended: false,
      revision: 0,
      alarmAt: 0,
      members: { [member.id]: member },
      sessions: [],
      tickets: {},
    };
    this.changed();
    return this.joined(member);
  }

  private async join(
    input: Extract<Command, { action: "join" }>["input"],
  ): Promise<Joined> {
    const [hash, inviteHash] = await Promise.all([
      digest(input.memberToken),
      digest(input.inviteToken),
    ]);
    const state = this.openState();
    const existing = state.members[input.memberId];
    if (existing) {
      if (!equalHash(existing.hash, hash))
        fail(403, "ACCESS_DENIED", "房间凭据无效。");
      this.assertActive(existing);
      return this.joined(existing);
    }
    if (!equalHash(inviteHash, state.inviteHash))
      fail(403, "INVITE_INVALID", "邀请已失效，请向房主索取新链接。");
    if (
      Object.values(state.members).filter(
        (m) => m.active && m.role === "viewer",
      ).length >= 20
    )
      fail(409, "ROOM_FULL", "房间已满，最多容纳 20 位观众。");
    if (Object.keys(state.members).length >= 200)
      fail(409, "ROOM_LIMIT", "此临时房间已达到累计加入上限，请创建新房间。");
    const member: Member = {
      id: input.memberId,
      name: input.name,
      hash,
      role: "viewer",
      active: true,
      lastSeen: Date.now(),
    };
    state.members[member.id] = member;
    this.changed();
    return this.joined(member);
  }

  private async authorize(auth: Auth): Promise<Member> {
    const hash = await digest(auth.token);
    const state = this.openState();
    const member = state.members[auth.memberId];
    if (!member || !equalHash(member.hash, hash))
      fail(403, "ACCESS_DENIED", "房间凭据无效，请重新打开邀请。");
    this.assertActive(member);
    return member;
  }
  private assertActive(member: Member): void {
    this.openState();
    if (!member.active)
      fail(
        403,
        member.reason ?? "ACCESS_DENIED",
        member.reason === "KICKED"
          ? "你已被房主移出房间。"
          : "此次加入已结束，请重新打开邀请。",
      );
  }
  private host(member: Member): void {
    this.assertActive(member);
    if (member.role !== "host")
      fail(403, "HOST_ONLY", "只有房主可以执行此操作。");
  }
  private requireState(): RoomState {
    if (!this.state) fail(404, "ROOM_NOT_FOUND", "房间不存在。");
    return this.state;
  }
  private openState(): RoomState {
    const state = this.requireState();
    if (state.ended || state.expiresAt <= Date.now())
      fail(410, "ROOM_ENDED", "房间已结束。");
    return state;
  }
  private joined(member: Member): Joined {
    return { selfId: member.id, role: member.role, snapshot: this.snapshot() };
  }
  private snapshot(): Snapshot {
    const state = this.requireState();
    const share = state.sessions.find(
      (s) => s.owner === state.hostId && s.phase === "ready",
    );
    return {
      roomId: state.roomId,
      revision: state.revision,
      ended: state.ended,
      expiresAt: state.expiresAt,
      members: Object.values(state.members)
        .filter((m) => m.active)
        .map((m) => ({
          id: m.id,
          name: m.name,
          role: m.role,
          online: Date.now() - m.lastSeen < 45_000,
        })),
      share: share
        ? { id: share.attemptId, kinds: share.tracks.map((t) => t.kind) }
        : null,
      cleanupPending: state.sessions.filter((s) => s.phase === "retired")
        .length,
    };
  }
  private save(): void {
    if (
      this.state &&
      (!this.state.alarmAt || this.state.alarmAt <= Date.now())
    ) {
      this.state.alarmAt = Date.now() + 15_000;
      this.ctx.waitUntil(this.ctx.storage.setAlarm(this.state.alarmAt));
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO room_state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      JSON.stringify(this.state),
    );
  }
  private changed(): void {
    this.requireState().revision += 1;
    this.save();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(
          JSON.stringify({ type: "changed", revision: this.state!.revision }),
        );
      } catch {
        ws.close(1011, "Reconnect");
      }
    }
  }
  private closeSockets(
    memberId?: string,
    code = 4003,
    reason = "Access ended",
  ): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (!memberId || ws.deserializeAttachment()?.memberId === memberId)
        ws.close(code, reason);
    }
  }
  private removeMember(member: Member, reason: Member["reason"]): void {
    member.active = false;
    member.reason = reason;
    for (const s of this.requireState().sessions)
      if (s.owner === member.id) this.retire(s);
    for (const [key, ticket] of Object.entries(this.requireState().tickets))
      if (ticket.memberId === member.id) delete this.state!.tickets[key];
    this.closeSockets(member.id);
  }
  private retire(session: Session): void {
    if (session.phase === "retired") return;
    session.phase = "retired";
    session.reply = undefined;
    session.probeUntil = session.uncertain ? Date.now() + CLEANUP_PROBE_MS : 0;
    session.retryAt = 0;
    this.cleanupSoon();
  }
  private cleanupSoon(): void {
    const at = Date.now() + 1000;
    if (this.state && (!this.state.alarmAt || this.state.alarmAt > at)) {
      this.state.alarmAt = at;
      this.ctx.waitUntil(this.ctx.storage.setAlarm(at));
    }
  }
  private retireAll(): void {
    for (const s of this.requireState().sessions) this.retire(s);
  }

  private mediaOperation<T>(
    member: Member,
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const existing = this.operations.get(member.id);
    if (existing) {
      if (existing.key === key) return existing.promise as Promise<T>;
      fail(409, "MEDIA_BUSY", "媒体连接正在更新，请稍后重试。", true);
    }
    const promise = fn().finally(() => {
      if (this.operations.get(member.id)?.promise === promise)
        this.operations.delete(member.id);
    });
    this.operations.set(member.id, { key, promise });
    return promise;
  }
  private currentSession(member: Member, attemptId: string): Session {
    this.assertActive(member);
    const session = this.requireState().sessions.find(
      (s) =>
        s.owner === member.id &&
        s.attemptId === attemptId &&
        s.phase !== "retired",
    );
    if (!session)
      fail(409, "MEDIA_STALE", "媒体连接已被替换，请重新连接。", true);
    return session;
  }
  private allocate(
    member: Member,
    attemptId: string,
    shareId: string,
  ): Session {
    const state = this.openState();
    if (state.sessions.some((s) => s.attemptId === attemptId))
      fail(409, "MEDIA_STALE", "请使用新的媒体连接。", true);
    if (
      state.sessions.filter((s) => s.owner === member.id).length >= 4 ||
      state.sessions.length >= 64
    )
      fail(503, "CLEANUP_PENDING", "旧媒体连接正在清理，请稍后重试。", true);
    const session: Session = {
      attemptId,
      owner: member.id,
      shareId,
      phase: "opening",
      mids: [],
      tracks: [],
      created: Date.now(),
      uncertain: false,
      probeUntil: 0,
      retryAt: 0,
      failures: 0,
    };
    state.sessions.push(session);
    this.save();
    return session;
  }
  private async establish(
    session: Session,
    body: unknown,
    operation: "publish" | "subscribe",
  ): Promise<MediaReply> {
    this.busySessions.add(session);
    try {
      session.id = await this.sfu.create();
      this.save();
      if (session.phase === "retired")
        fail(409, "MEDIA_STALE", "媒体连接已取消。", true);
      session.uncertain = true;
      this.save();
      const reply = await this.sfu.tracks(session.id, body);
      this.remember(session, reply);
      this.sfu.check(reply);
      if (
        !reply.sessionDescription ||
        !reply.tracks?.length ||
        reply.tracks.some((t) => !t.mid) ||
        reply.tracks.length !== session.tracks.length
      )
        fail(502, "SFU_INVALID", "媒体轨道响应不完整。", true);
      if (operation === "publish" && reply.sessionDescription.type !== "answer")
        fail(502, "SFU_INVALID", "媒体发布协商失败。", true);
      if (
        operation === "subscribe" &&
        reply.sessionDescription.type !== "offer"
      )
        fail(502, "SFU_INVALID", "媒体接收协商失败。", true);
      session.uncertain = false;
      this.currentSession(
        this.state!.members[session.owner]!,
        session.attemptId,
      );
      if (
        operation === "subscribe" &&
        !this.state!.sessions.some(
          (s) =>
            s.owner === this.state!.hostId &&
            s.attemptId === session.shareId &&
            s.phase === "ready",
        )
      )
        fail(409, "SHARE_CHANGED", "房主正在切换共享。", true);
      session.mids = reply.tracks.map((t) => t.mid!);
      session.tracks = session.tracks.map((t, i) => ({
        kind: t.kind,
        mid: session.mids[i]!,
      }));
      session.phase = "pending";
      session.reply = {
        attemptId: session.attemptId,
        description: reply.sessionDescription,
        tracks: session.tracks,
        requiresAnswer: operation === "subscribe",
      };
      this.save();
      return session.reply;
    } catch (error) {
      this.retire(session);
      this.save();
      throw error;
    } finally {
      this.busySessions.delete(session);
      // Durable alarms own cleanup. An unrelated old SFU request must not delay
      // the new connection's SDP response and cause another connection attempt.
      if (this.state!.sessions.some((s) => s.phase === "retired")) {
        this.cleanupSoon();
        this.save();
      }
    }
  }
  private remember(session: Session, reply: SfuReply): void {
    session.mids = [
      ...new Set([
        ...session.mids,
        ...(reply.tracks ?? []).flatMap((t) => (t.mid ? [t.mid] : [])),
      ]),
    ];
    this.save();
  }
  private async publish(
    member: Member,
    input: Extract<Command, { action: "publish" }>["input"],
  ): Promise<MediaReply> {
    const duplicate = this.state!.sessions.find(
      (s) =>
        s.owner === member.id &&
        s.attemptId === input.attemptId &&
        s.phase !== "retired",
    );
    if (duplicate?.reply) return duplicate.reply;
    this.retireAll();
    this.changed();
    const session = this.allocate(member, input.attemptId, input.attemptId);
    session.tracks = input.tracks;
    return this.establish(
      session,
      {
        sessionDescription: input.description,
        tracks: input.tracks.map((t) => ({
          location: "local",
          mid: t.mid,
          trackName: t.kind,
        })),
      },
      "publish",
    );
  }
  private async subscribe(
    member: Member,
    input: Extract<Command, { action: "subscribe" }>["input"],
  ): Promise<MediaReply> {
    const share = this.state!.sessions.find(
      (s) =>
        s.owner === this.state!.hostId &&
        s.attemptId === input.shareId &&
        s.phase === "ready",
    );
    if (!share?.id) fail(409, "SHARE_CHANGED", "共享已停止或正在恢复。", true);
    const duplicate = this.state!.sessions.find(
      (s) =>
        s.owner === member.id &&
        s.attemptId === input.attemptId &&
        s.phase !== "retired",
    );
    if (duplicate?.reply) return duplicate.reply;
    for (const s of this.state!.sessions)
      if (s.owner === member.id) this.retire(s);
    const session = this.allocate(member, input.attemptId, input.shareId);
    session.tracks = share.tracks.map((t) => ({ ...t }));
    return this.establish(
      session,
      {
        tracks: share.tracks.map((t) => ({
          location: "remote",
          sessionId: share.id,
          trackName: t.kind,
        })),
      },
      "subscribe",
    );
  }
  private async answer(
    member: Member,
    input: Extract<Command, { action: "answer" }>["input"],
  ): Promise<Snapshot> {
    const session = this.currentSession(member, input.attemptId);
    if (member.role !== "viewer")
      fail(403, "VIEWER_ONLY", "只有观众需要接收协商。");
    if (session.phase === "ready") return this.snapshot();
    if (session.phase !== "pending" || !session.id)
      fail(409, "MEDIA_STALE", "媒体连接已失效。", true);
    this.busySessions.add(session);
    try {
      session.uncertain = true;
      this.save();
      this.sfu.check(await this.sfu.answer(session.id, input.description));
      this.currentSession(member, input.attemptId);
      session.uncertain = false;
      session.phase = "ready";
      this.save();
      return this.snapshot();
    } catch (error) {
      this.retire(session);
      this.save();
      throw error;
    } finally {
      this.busySessions.delete(session);
    }
  }

  private cleanup(): Promise<void> {
    if (this.cleaning) return this.cleaning;
    this.cleaning = this.performCleanup().finally(() => {
      this.cleaning = undefined;
    });
    return this.cleaning;
  }
  private async performCleanup(): Promise<void> {
    if (!this.state) return;
    const sessions = this.state.sessions.filter(
      (s) =>
        s.phase === "retired" &&
        !this.busySessions.has(s) &&
        s.retryAt <= Date.now(),
    );
    await Promise.all(
      sessions.map(async (session) => {
        try {
          if (session.id) {
            // After an uncertain allocation, inspect as well as closing known mids.
            if (session.uncertain) {
              const inspected = await this.sfu.inspect(session.id);
              this.sfu.check(inspected);
              this.remember(session, inspected);
            }
            if (session.mids.length)
              this.sfu.check(
                await this.sfu.close(session.id, session.mids),
                true,
              );
            if (session.uncertain && Date.now() < session.probeUntil) {
              session.retryAt = Date.now() + 15_000;
              this.save();
              return;
            }
          }
          this.state!.sessions = this.state!.sessions.filter(
            (s) => s !== session,
          );
        } catch (error) {
          if (error instanceof AppError && error.code === "SFU_ABSENT")
            this.state!.sessions = this.state!.sessions.filter(
              (s) => s !== session,
            );
          else {
            session.failures += 1;
            session.retryAt =
              Date.now() +
              Math.min(60_000, 1000 * 2 ** Math.min(session.failures, 6));
          }
        }
        this.save();
      }),
    );
  }

  async alarm(): Promise<void> {
    if (!this.state) return;
    this.state.alarmAt = 0;
    const now = Date.now();
    let changed = false;
    if (this.state.expiresAt <= now && !this.state.ended) {
      this.state.ended = true;
      this.retireAll();
      this.closeSockets();
      changed = true;
    }
    for (const member of Object.values(this.state.members)) {
      if (member.active && now - member.lastSeen > LEASE_MS) {
        if (member.role === "viewer") this.removeMember(member, "EXPIRED");
        else this.retireAll();
        changed = true;
      }
    }
    for (const session of this.state.sessions) {
      if (
        (session.phase === "opening" || session.phase === "pending") &&
        now - session.created > NEGOTIATION_MS &&
        !this.busySessions.has(session)
      ) {
        session.uncertain = true;
        this.retire(session);
        changed = true;
      }
    }
    for (const [key, ticket] of Object.entries(this.state.tickets))
      if (ticket.expiresAt <= now) delete this.state.tickets[key];
    if (changed) this.changed();
    await this.cleanup();
    if (!this.state.ended || this.state.sessions.length) this.save();
    else await this.ctx.storage.deleteAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        fail(400, "WEBSOCKET_REQUIRED", "需要 WebSocket 连接。");
      const protocols =
        request.headers
          .get("Sec-WebSocket-Protocol")
          ?.split(",")
          .map((v) => v.trim()) ?? [];
      const raw = protocols.find((v) => v.startsWith("ticket."))?.slice(7);
      if (!raw || !protocols.includes("piik.v1"))
        fail(403, "TICKET_INVALID", "通知连接凭据无效。");
      const hash = await digest(raw);
      const state = this.openState();
      const ticket = state.tickets[hash];
      if (!ticket || ticket.expiresAt <= Date.now())
        fail(403, "TICKET_INVALID", "通知连接凭据已过期。");
      const member = state.members[ticket.memberId]!;
      this.assertActive(member);
      delete state.tickets[hash];
      this.save();
      this.closeSockets(member.id, 4001, "Replaced by another tab");
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ memberId: member.id });
      return new Response(null, {
        status: 101,
        webSocket: pair[0],
        headers: { "Sec-WebSocket-Protocol": "piik.v1" },
      });
    } catch (error) {
      const result = failure(error);
      return Response.json({ error: result.error }, { status: result.status });
    }
  }
  webSocketMessage(socket: WebSocket): void {
    socket.close(1008, "Notifications only");
  }
  webSocketClose(): void {}
  webSocketError(socket: WebSocket): void {
    socket.close(1011, "Reconnect");
  }

  private async iceServers() {
    const fallback = {
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    };
    if (!this.env.TURN_KEY_ID || !this.env.TURN_API_TOKEN) return fallback;
    try {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.TURN_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl: 3600 }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok)
        fail(502, "TURN_UNAVAILABLE", "中继凭据暂时无法签发。", true);
      const parsed = iceSchema.safeParse(await response.json());
      if (!parsed.success)
        fail(502, "TURN_INVALID", "中继凭据格式无效。", true);
      return parsed.data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      fail(502, "TURN_UNAVAILABLE", "中继服务暂时无法连接。", true);
    }
  }
}
