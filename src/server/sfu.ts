import { z } from "zod";
import { descriptionSchema } from "../shared/protocol";
import { AppError, fail } from "./errors";

const itemSchema = z.looseObject({
  mid: z.string().optional(),
  trackName: z.string().optional(),
  errorCode: z.string().optional(),
  errorDescription: z.string().optional(),
});
const replySchema = z.looseObject({
  sessionId: z.string().optional(),
  sessionDescription: descriptionSchema.optional(),
  requiresImmediateRenegotiation: z.boolean().optional(),
  tracks: z.array(itemSchema).optional(),
  errorCode: z.string().optional(),
  errorDescription: z.string().optional(),
});
export type SfuReply = z.infer<typeof replySchema>;

/** Only trusted code chooses the path, session and publications. Never a browser proxy. */
export class Sfu {
  constructor(private env: Env) {}

  async request(
    path: string,
    method = "POST",
    body?: unknown,
  ): Promise<SfuReply> {
    if (!this.env.REALTIME_SFU_APP_ID || !this.env.REALTIME_SFU_BEARER_TOKEN)
      fail(503, "SFU_NOT_CONFIGURED", "尚未配置 Cloudflare SFU 凭据。", false);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 10_000);
    try {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(this.env.REALTIME_SFU_APP_ID)}${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.env.REALTIME_SFU_BEARER_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: timeout.signal,
        },
      );
      if (response.status === 404 || response.status === 410)
        throw new AppError(
          response.status,
          "SFU_ABSENT",
          "媒体连接已结束，请重新连接。",
          true,
        );
      if (!response.ok)
        fail(
          502,
          "SFU_UNAVAILABLE",
          "媒体服务暂时无法完成请求。",
          response.status === 429 || response.status >= 500,
        );
      const parsed = replySchema.safeParse(await response.json());
      if (!parsed.success)
        fail(502, "SFU_INVALID", "媒体服务返回了无效响应，请重新连接。", true);
      return parsed.data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      fail(502, "SFU_UNREACHABLE", "媒体服务连接失败，请稍后重试。", true);
    } finally {
      clearTimeout(timer);
    }
  }

  async create(): Promise<string> {
    const reply = await this.request("/sessions/new");
    this.check(reply);
    if (!reply.sessionId)
      fail(502, "SFU_INVALID", "媒体服务没有返回连接标识。", true);
    return reply.sessionId;
  }
  tracks(id: string, body: unknown) {
    return this.request(
      `/sessions/${encodeURIComponent(id)}/tracks/new`,
      "POST",
      body,
    );
  }
  answer(id: string, description: unknown) {
    return this.request(
      `/sessions/${encodeURIComponent(id)}/renegotiate`,
      "PUT",
      { sessionDescription: description },
    );
  }
  inspect(id: string) {
    return this.request(`/sessions/${encodeURIComponent(id)}`, "GET");
  }
  close(id: string, mids: string[]) {
    return this.request(
      `/sessions/${encodeURIComponent(id)}/tracks/close`,
      "PUT",
      { force: true, tracks: mids.map((mid) => ({ mid })) },
    );
  }
  check(reply: SfuReply, closing = false): void {
    if (
      reply.errorCode ||
      reply.errorDescription ||
      reply.tracks?.some(
        (t) =>
          (t.errorCode || t.errorDescription) &&
          !(closing && t.errorCode === "close_track_error"),
      )
    ) {
      fail(
        502,
        "SFU_TRACK_ERROR",
        closing
          ? "媒体清理尚未完成，服务端将继续重试。"
          : "媒体轨道建立失败，请重新连接。",
        true,
      );
    }
  }
}
