import type { z } from "zod";
import { errorSchema } from "../shared/protocol";

export type Credentials = {
  roomId: string;
  memberId: string;
  memberToken: string;
  name: string;
  role: "host" | "viewer";
  inviteToken?: string;
};
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status = 0,
  ) {
    super(message);
  }
}
export async function request<S extends z.ZodType>(
  path: string,
  schema: S,
  body?: unknown,
  credentials?: Credentials,
  method = "POST",
): Promise<z.infer<S>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(credentials
          ? {
              "x-piik-member": credentials.memberId,
              Authorization: `Bearer ${credentials.memberToken}`,
            }
          : {}),
      },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch {
    throw new ApiError("NETWORK", "连接暂时中断，正在等待网络恢复。", true);
  }
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorSchema.safeParse(value);
    throw error.success
      ? new ApiError(
          error.data.error.code,
          error.data.error.message,
          error.data.error.retryable,
          response.status,
        )
      : new ApiError(
          "INVALID_RESPONSE",
          "服务响应异常，请稍后重试。",
          response.status >= 500,
          response.status,
        );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      "INVALID_RESPONSE",
      "服务响应格式无效，请重新连接。",
      false,
    );
  return parsed.data;
}
export function capability(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
