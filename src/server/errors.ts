export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export function fail(
  status: number,
  code: string,
  message: string,
  retryable = false,
): never {
  throw new AppError(status, code, message, retryable);
}

export function failure(error: unknown) {
  if (error instanceof AppError)
    return {
      ok: false as const,
      status: error.status,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
    };
  // Provider payloads and request bodies can include private SDP or credentials.
  console.error(
    JSON.stringify({
      event: "unexpected_error",
      type: error instanceof Error ? error.name : "unknown",
    }),
  );
  return {
    ok: false as const,
    status: 500,
    error: {
      code: "INTERNAL",
      message: "服务暂时不可用，请稍后重试。",
      retryable: true,
    },
  };
}

export function token(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export async function digest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
}
export function equalHash(a: string, b: string): boolean {
  return crypto.subtle.timingSafeEqual(
    new TextEncoder().encode(a),
    new TextEncoder().encode(b),
  );
}
