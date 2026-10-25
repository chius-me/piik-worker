import { exports as worker } from "cloudflare:workers";
import {
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";
import type { Joined, MediaReply, Snapshot } from "../../src/shared/protocol";
import type { RoomState } from "../../src/server/room";
import { mockSfu, network } from "./sfu-mock";

const origin = "http://localhost";
type Identity = { memberId: string; memberToken: string };
const identity = (): Identity => ({
  memberId: crypto.randomUUID(),
  memberToken: btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", ""),
});
const inviteToken = () => identity().memberToken;
async function call(
  path: string,
  input?: unknown,
  auth?: Identity,
  method = "POST",
) {
  const response = await worker.default.fetch(`${origin}${path}`, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(auth
        ? {
            "x-piik-member": auth.memberId,
            Authorization: `Bearer ${auth.memberToken}`,
          }
        : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(input ?? {}),
  });
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: response.headers,
  });
}
async function create() {
  const host = identity();
  const invite = inviteToken();
  const roomId = crypto.randomUUID();
  const response = await call("/api/rooms", {
    roomId,
    ...host,
    name: "房主",
    inviteToken: invite,
  });
  expect(response.status).toBe(200);
  return {
    host,
    invite,
    roomId,
    joined: (await response.json()) as Joined,
    path: `/api/rooms/${roomId}`,
  };
}
async function join(room: Awaited<ReturnType<typeof create>>, name = "朋友") {
  const viewer = identity();
  const response = await call(`${room.path}/join`, {
    ...viewer,
    name,
    inviteToken: room.invite,
  });
  expect(response.status).toBe(200);
  return viewer;
}
async function publish(room: Awaited<ReturnType<typeof create>>) {
  const attemptId = crypto.randomUUID();
  const input = {
    attemptId,
    description: { type: "offer", sdp: "offer" },
    tracks: [
      { mid: "0", kind: "video" },
      { mid: "1", kind: "audio" },
    ],
  };
  const response = await call(`${room.path}/publish`, input, room.host);
  expect(response.status).toBe(200);
  const reply = (await response.json()) as MediaReply;
  expect(reply.tracks.map((t) => t.kind)).toEqual(["video", "audio"]);
  expect(
    (await call(`${room.path}/ready`, { attemptId }, room.host)).status,
  ).toBe(200);
  return { attemptId, input, reply };
}

test("room authority and invitation digests survive DO eviction without persisting secrets", async () => {
  const room = await create();
  const viewer = await join(room);
  const stub = worker.Room.getByName(room.roomId);
  await runInDurableObject(stub, async (_instance, ctx) => {
    const raw = ctx.storage.sql
      .exec<{ data: string }>("SELECT data FROM room_state")
      .one().data;
    expect(raw).not.toContain(room.host.memberToken);
    expect(raw).not.toContain(room.invite);
    expect(raw).not.toContain(viewer.memberToken);
  });
  await evictDurableObject(stub);
  const snapshot = (await (
    await call(`${room.path}/snapshot`, undefined, viewer, "GET")
  ).json()) as Snapshot;
  expect(snapshot.members).toHaveLength(2);
  expect(snapshot.share).toBeNull();
});

test("concurrent joins enforce 20 viewers, and retrying a join does not consume another seat", async () => {
  const room = await create();
  const viewers = Array.from({ length: 21 }, identity);
  const responses = await Promise.all(
    viewers.map((v) =>
      call(`${room.path}/join`, {
        ...v,
        name: "朋友",
        inviteToken: room.invite,
      }),
    ),
  );
  expect(responses.filter((r) => r.status === 200)).toHaveLength(20);
  expect(responses.filter((r) => r.status === 409)).toHaveLength(1);
  const index = responses.findIndex((r) => r.status === 200);
  expect(
    (
      await call(`${room.path}/join`, {
        ...viewers[index],
        name: "朋友",
        inviteToken: room.invite,
      })
    ).status,
  ).toBe(200);
});

test("authorization rejects another room, a viewer publisher, and viewer moderation", async () => {
  mockSfu();
  const room = await create();
  const viewer = await join(room);
  const other = await create();
  expect(
    (await call(`${other.path}/snapshot`, undefined, viewer, "GET")).status,
  ).toBe(403);
  expect(
    (
      await call(
        `${room.path}/publish`,
        {
          attemptId: crypto.randomUUID(),
          description: { type: "offer", sdp: "x" },
          tracks: [{ mid: "0", kind: "video" }],
        },
        viewer,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call(
        `${room.path}/kick`,
        { memberId: room.host.memberId, inviteToken: inviteToken() },
        viewer,
      )
    ).status,
  ).toBe(403);
  expect((await call(`${room.path}/stop`, {}, viewer)).status).toBe(403);
});

test("publish, subscribe, reconnect and kick close the allocated provider sessions", async () => {
  const sfu = mockSfu();
  const room = await create();
  const viewer = await join(room);
  const first = await publish(room);
  const attemptId = crypto.randomUUID();
  const response = await call(
    `${room.path}/subscribe`,
    { attemptId, shareId: first.attemptId },
    viewer,
  );
  expect(response.status).toBe(200);
  const reply = (await response.json()) as MediaReply;
  expect(reply.requiresAnswer).toBe(true);
  expect(
    (
      await call(
        `${room.path}/answer`,
        { attemptId, description: { type: "answer", sdp: "answer" } },
        viewer,
      )
    ).status,
  ).toBe(200);
  const next = await publish(room);
  expect(next.attemptId).not.toBe(first.attemptId);
  expect(
    (
      await call(
        `${room.path}/answer`,
        { attemptId, description: { type: "answer", sdp: "old" } },
        viewer,
      )
    ).status,
  ).toBe(409);
  await runDurableObjectAlarm(worker.Room.getByName(room.roomId));
  expect(sfu.closed).toContain("s-1");
  expect(sfu.closed).toContain("s-2");
  const subscription = crypto.randomUUID();
  await call(
    `${room.path}/subscribe`,
    { attemptId: subscription, shareId: next.attemptId },
    viewer,
  );
  const newInvite = inviteToken();
  const kicked = await call(
    `${room.path}/kick`,
    { memberId: viewer.memberId, inviteToken: newInvite },
    room.host,
  );
  expect(kicked.status).toBe(200);
  expect(sfu.closed).toContain("s-4");
  expect(
    (await call(`${room.path}/snapshot`, undefined, viewer, "GET")).status,
  ).toBe(403);
  expect(
    (
      await call(`${room.path}/join`, {
        ...identity(),
        name: "重试",
        inviteToken: room.invite,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call(`${room.path}/join`, {
        ...identity(),
        name: "新朋友",
        inviteToken: newInvite,
      })
    ).status,
  ).toBe(200);
  const snap = (await (
    await call(`${room.path}/snapshot`, undefined, room.host, "GET")
  ).json()) as Snapshot;
  expect(snap.share?.id).toBe(next.attemptId);
});

test("a kick fences an in-flight subscription and cleans up its late allocation", async () => {
  const sfu = mockSfu();
  const room = await create();
  const viewer = await join(room);
  const share = await publish(room);
  let released = false;
  let started = false;
  network.use(
    http.post(
      "https://rtc.live.cloudflare.com/v1/apps/test-app/sessions/s-2/tracks/new",
      async () => {
        started = true;
        while (!released)
          await new Promise((resolve) => setTimeout(resolve, 1));
        return HttpResponse.json({
          sessionDescription: { type: "offer", sdp: "late" },
          tracks: [{ mid: "0" }, { mid: "1" }],
        });
      },
    ),
  );
  const pending = call(
    `${room.path}/subscribe`,
    { attemptId: crypto.randomUUID(), shareId: share.attemptId },
    viewer,
  );
  while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
  const result = await call(
    `${room.path}/kick`,
    { memberId: viewer.memberId, inviteToken: inviteToken() },
    room.host,
  );
  expect(result.status).toBe(200);
  released = true;
  expect((await pending).status).toBe(403);
  await runDurableObjectAlarm(worker.Room.getByName(room.roomId));
  expect(sfu.closed).toContain("s-2");
});

test("partial SFU errors retain allocated mids; cleanup failure persists across eviction and retries", async () => {
  mockSfu();
  const room = await create();
  network.use(
    http.post(
      "https://rtc.live.cloudflare.com/v1/apps/test-app/sessions/:id/tracks/new",
      () =>
        HttpResponse.json({
          sessionDescription: { type: "answer", sdp: "a" },
          tracks: [
            { mid: "0" },
            {
              errorCode: "invalid_track",
              errorDescription: "private upstream diagnostic",
            },
          ],
        }),
    ),
  );
  let closing = false;
  network.use(
    http.put(
      "https://rtc.live.cloudflare.com/v1/apps/test-app/sessions/:id/tracks/close",
      () =>
        closing
          ? HttpResponse.json({ tracks: [{ mid: "0" }] })
          : HttpResponse.json({
              tracks: [{ mid: "0", errorCode: "temporary_failure" }],
            }),
    ),
  );
  const input = {
    attemptId: crypto.randomUUID(),
    description: { type: "offer", sdp: "x" },
    tracks: [
      { mid: "0", kind: "video" },
      { mid: "1", kind: "audio" },
    ],
  };
  const response = await call(`${room.path}/publish`, input, room.host);
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("private upstream diagnostic");
  const stub = worker.Room.getByName(room.roomId);
  await runDurableObjectAlarm(stub);
  await evictDurableObject(stub);
  await runInDurableObject(stub, (_instance, ctx) => {
    const state = JSON.parse(
      ctx.storage.sql
        .exec<{ data: string }>("SELECT data FROM room_state")
        .one().data,
    ) as RoomState;
    expect(state.sessions[0]?.mids).toContain("0");
    expect(state.sessions[0]?.phase).toBe("retired");
    state.sessions[0]!.retryAt = 0;
    state.sessions[0]!.probeUntil = 0;
    ctx.storage.sql.exec("UPDATE room_state SET data=?", JSON.stringify(state));
  });
  closing = true;
  await evictDurableObject(stub);
  await runDurableObjectAlarm(stub);
  const snap = (await (
    await call(`${room.path}/snapshot`, undefined, room.host, "GET")
  ).json()) as Snapshot;
  expect(snap.cleanupPending).toBe(0);
  expect(snap.share).toBeNull();
});

test("stopping sharing fences a late publish while preserving room membership", async () => {
  const sfu = mockSfu();
  const room = await create();
  let released = false;
  let started = false;
  network.use(
    http.post(
      "https://rtc.live.cloudflare.com/v1/apps/test-app/sessions/s-1/tracks/new",
      async () => {
        started = true;
        while (!released)
          await new Promise((resolve) => setTimeout(resolve, 1));
        return HttpResponse.json({
          sessionDescription: { type: "answer", sdp: "late" },
          tracks: [{ mid: "0" }],
        });
      },
    ),
  );
  const pending = call(
    `${room.path}/publish`,
    {
      attemptId: crypto.randomUUID(),
      description: { type: "offer", sdp: "offer" },
      tracks: [{ mid: "0", kind: "video" }],
    },
    room.host,
  );
  while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
  expect((await call(`${room.path}/stop`, {}, room.host)).status).toBe(200);
  released = true;
  expect((await pending).status).toBe(409);
  await runDurableObjectAlarm(worker.Room.getByName(room.roomId));
  expect(sfu.closed).toContain("s-1");
  const snap = (await (
    await call(`${room.path}/snapshot`, undefined, room.host, "GET")
  ).json()) as Snapshot;
  expect(snap.share).toBeNull();
  expect(snap.members).toHaveLength(1);
});

test("expired presence retires media, while host ownership survives for a new share", async () => {
  const sfu = mockSfu();
  const room = await create();
  const viewer = await join(room);
  await publish(room);
  const stub = worker.Room.getByName(room.roomId);
  await runInDurableObject(stub, (_instance, ctx) => {
    const state = JSON.parse(
      ctx.storage.sql
        .exec<{ data: string }>("SELECT data FROM room_state")
        .one().data,
    ) as RoomState;
    for (const member of Object.values(state.members))
      member.lastSeen = Date.now() - 121_000;
    ctx.storage.sql.exec("UPDATE room_state SET data=?", JSON.stringify(state));
  });
  await evictDurableObject(stub);
  await runDurableObjectAlarm(stub);
  expect(sfu.closed).toContain("s-1");
  expect(
    (await call(`${room.path}/snapshot`, undefined, viewer, "GET")).status,
  ).toBe(403);
  const snap = (await (
    await call(`${room.path}/snapshot`, undefined, room.host, "GET")
  ).json()) as Snapshot;
  expect(snap.share).toBeNull();
  expect(snap.members).toHaveLength(1);
  await publish(room);
});

test("notification tickets are single-use, omit credentials from URLs, and survive hibernation", async () => {
  const room = await create();
  const viewer = await join(room);
  const { ticket } = (await (
    await call(`${room.path}/ticket`, {}, viewer)
  ).json()) as { ticket: string };
  const url = `${origin}${room.path}/socket`;
  const headers = {
    Origin: origin,
    Upgrade: "websocket",
    "Sec-WebSocket-Protocol": `piik.v1, ticket.${ticket}`,
  };
  const response = await worker.default.fetch(url, { headers });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const duplicate = await worker.default.fetch(url, { headers });
  expect(duplicate.status).toBe(403);
  await duplicate.text();
  await runInDurableObject(
    worker.Room.getByName(room.roomId),
    (_instance, ctx) => {
      expect(ctx.getWebSockets()).toHaveLength(1);
    },
  );
  const next = new Promise<string>((resolve) => {
    socket.addEventListener("message", (event) => resolve(String(event.data)), {
      once: true,
    });
  });
  await evictDurableObject(worker.Room.getByName(room.roomId));
  await runInDurableObject(
    worker.Room.getByName(room.roomId),
    (_instance, ctx) => {
      expect(ctx.getWebSockets()).toHaveLength(1);
    },
  );
  await call(`${room.path}/invite`, { inviteToken: inviteToken() }, room.host);
  expect(JSON.parse(await next).type).toBe("changed");
  socket.close();
});

test("origin, payload bounds and room termination fail closed", async () => {
  const response = await worker.default.fetch(`${origin}/api/rooms`, {
    method: "POST",
    headers: {
      Origin: "https://attacker.invalid",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  expect(response.status).toBe(403);
  expect(
    (await call("/api/rooms", { padding: "x".repeat(256_000) })).status,
  ).toBe(413);
  const room = await create();
  const viewer = await join(room);
  expect((await call(`${room.path}/end`, {}, room.host)).status).toBe(200);
  expect(
    (await call(`${room.path}/snapshot`, undefined, viewer, "GET")).status,
  ).toBe(410);
});

test("authorized members receive short-lived TURN ICE servers without the TURN API token", async () => {
  const room = await create();
  const viewer = await join(room);
  let issued = 0;
  network.use(
    http.post(
      "https://rtc.live.cloudflare.com/v1/turn/keys/test-turn-key/credentials/generate-ice-servers",
      async ({ request }) => {
        expect(request.headers.get("Authorization")).toBe("Bearer test-turn-token");
        expect(await request.json()).toEqual({ ttl: 3600 });
        issued += 1;
        return HttpResponse.json({
          iceServers: [
            { urls: ["stun:stun.cloudflare.com:3478"] },
            {
              urls: ["turns:turn.cloudflare.com:443?transport=tcp"],
              username: "temporary-user",
              credential: "temporary-credential",
            },
          ],
        });
      },
    ),
  );
  const response = await call(`${room.path}/ice`, {}, viewer);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain("temporary-credential");
  expect(text).not.toContain("test-turn-token");
  expect(issued).toBe(1);
  const other = await create();
  expect((await call(`${other.path}/ice`, {}, viewer)).status).toBe(403);
  expect(issued).toBe(1);
});
