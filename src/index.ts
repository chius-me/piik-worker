import { z } from "zod";
import {
  answerSchema,
  attemptSchema,
  createSchema,
  idSchema,
  inviteSchema,
  joinSchema,
  kickSchema,
  publishSchema,
  subscribeSchema,
  tokenSchema,
  type Auth,
  type Command,
} from "./shared/protocol";
import { fail, failure } from "./server/errors";
export { Room } from "./server/room";

const MAX_BODY = 256_000;
const schemas = {
  publish: publishSchema,
  subscribe: subscribeSchema,
  answer: answerSchema,
  ready: attemptSchema,
  kick: kickSchema,
  invite: inviteSchema,
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/"))
        return secure(await env.ASSETS.fetch(request));
      if (
        request.headers.has("Origin") &&
        request.headers.get("Origin") !== url.origin
      )
        fail(403, "ORIGIN_DENIED", "请求来源无效。");
      if (
        request.method !== "GET" &&
        request.headers.get("Origin") !== url.origin
      )
        fail(403, "ORIGIN_DENIED", "操作需要同源请求。");
      if (url.pathname === "/api/health" && request.method === "GET")
        return json({
          sfuConfigured: Boolean(
            env.REALTIME_SFU_APP_ID && env.REALTIME_SFU_BEARER_TOKEN,
          ),
        });
      let roomId: string;
      let command: Command;
      if (url.pathname === "/api/rooms" && request.method === "POST") {
        const input = parse(createSchema, await body(request));
        roomId = input.roomId;
        command = { action: "create", input };
      } else {
        const match = /^\/api\/rooms\/([^/]+)\/([a-z]+)$/.exec(url.pathname);
        if (!match) fail(404, "NOT_FOUND", "接口不存在。");
        roomId = parse(idSchema, match[1]);
        const action = match[2]!;
        if (action === "socket" && request.method === "GET") {
          if (request.headers.get("Origin") !== url.origin)
            fail(403, "ORIGIN_DENIED", "通知连接需要同源请求。");
          return ctx.exports.Room.getByName(roomId).fetch(request);
        }
        if (action === "join" && request.method === "POST")
          command = { action, input: parse(joinSchema, await body(request)) };
        else {
          const auth: Auth = {
            memberId: parse(idSchema, request.headers.get("x-piik-member")),
            token: parse(
              tokenSchema,
              request.headers.get("Authorization")?.replace(/^Bearer /, ""),
            ),
          };
          if (action === "snapshot" && request.method === "GET")
            command = { action, auth };
          else if (
            ["stop", "leave", "end", "ticket", "ice"].includes(action) &&
            request.method === "POST"
          ) {
            await body(request);
            command = {
              action: action as "stop" | "leave" | "end" | "ticket" | "ice",
              auth,
            };
          } else if (action in schemas && request.method === "POST") {
            const value = await body(request);
            // Separate branches preserve the request/command discriminated union.
            switch (action) {
              case "publish":
                command = { action, auth, input: parse(publishSchema, value) };
                break;
              case "subscribe":
                command = {
                  action,
                  auth,
                  input: parse(subscribeSchema, value),
                };
                break;
              case "answer":
                command = { action, auth, input: parse(answerSchema, value) };
                break;
              case "ready":
                command = { action, auth, input: parse(attemptSchema, value) };
                break;
              case "kick":
                command = { action, auth, input: parse(kickSchema, value) };
                break;
              case "invite":
                command = { action, auth, input: parse(inviteSchema, value) };
                break;
              default:
                fail(404, "NOT_FOUND", "接口不存在。");
            }
          } else fail(404, "NOT_FOUND", "接口不存在。");
        }
      }
      const result = await ctx.exports.Room.getByName(roomId).invoke(command);
      return result.ok
        ? json(result.value)
        : json({ error: result.error }, result.status);
    } catch (error) {
      const result = failure(error);
      return json({ error: result.error }, result.status);
    }
  },
} satisfies ExportedHandler<Env>;

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    fail(400, "INVALID_REQUEST", "请求格式无效，请刷新后重试。");
  return result.data;
}
async function body(request: Request): Promise<unknown> {
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    fail(415, "JSON_REQUIRED", "需要 JSON 请求。");
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        fail(413, "BODY_TOO_LARGE", "请求内容过大。");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      fail(400, "INVALID_JSON", "JSON 内容无效。");
    }
  } finally {
    reader.releaseLock();
  }
}
function json(value: unknown, status = 200): Response {
  return secure(
    Response.json(value, { status, headers: { "Cache-Control": "no-store" } }),
  );
}
function secure(response: Response): Response {
  const copy = new Response(response.body, response);
  copy.headers.set("X-Content-Type-Options", "nosniff");
  copy.headers.set("Referrer-Policy", "no-referrer");
  copy.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(self), display-capture=(self)",
  );
  copy.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  return copy;
}
