import { z } from "zod";

export const idSchema = z.uuid();
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const nameSchema = z.string().trim().min(1).max(32);
export const descriptionSchema = z.object({
  type: z.enum(["offer", "answer"]),
  sdp: z.string().min(1).max(200_000),
});
export const trackSchema = z.object({
  mid: z.string().regex(/^[\w.:-]{1,64}$/),
  kind: z.enum(["audio", "video"]),
});
const identity = { memberId: idSchema, memberToken: tokenSchema };
export const createSchema = z.object({
  roomId: idSchema,
  name: nameSchema,
  ...identity,
  inviteToken: tokenSchema,
});
export const joinSchema = z.object({
  name: nameSchema,
  ...identity,
  inviteToken: tokenSchema,
});
export const publishSchema = z.object({
  attemptId: idSchema,
  description: descriptionSchema.refine((v) => v.type === "offer"),
  tracks: z
    .array(trackSchema)
    .min(1)
    .max(2)
    .refine(
      (v) =>
        v.some((t) => t.kind === "video") &&
        new Set(v.map((t) => t.kind)).size === v.length,
    ),
});
export const subscribeSchema = z.object({
  attemptId: idSchema,
  shareId: idSchema,
});
export const answerSchema = z.object({
  attemptId: idSchema,
  description: descriptionSchema.refine((v) => v.type === "answer"),
});
export const attemptSchema = z.object({ attemptId: idSchema });
export const kickSchema = z.object({
  memberId: idSchema,
  inviteToken: tokenSchema,
});
export const inviteSchema = z.object({ inviteToken: tokenSchema });
export const memberSchema = z.object({
  id: idSchema,
  name: z.string(),
  role: z.enum(["host", "viewer"]),
  online: z.boolean(),
});
export const snapshotSchema = z.object({
  roomId: idSchema,
  revision: z.number().int(),
  ended: z.boolean(),
  expiresAt: z.number(),
  members: z.array(memberSchema),
  share: z
    .object({ id: idSchema, kinds: z.array(z.enum(["audio", "video"])) })
    .nullable(),
  cleanupPending: z.number().int().nonnegative(),
});
export const joinedSchema = z.object({
  selfId: idSchema,
  role: z.enum(["host", "viewer"]),
  snapshot: snapshotSchema,
});
export const mediaSchema = z.object({
  attemptId: idSchema,
  description: descriptionSchema,
  tracks: z.array(trackSchema),
  requiresAnswer: z.boolean(),
});
export const ticketSchema = z.object({ ticket: tokenSchema });
export const healthSchema = z.object({ sfuConfigured: z.boolean() });
export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
});
export const iceSchema = z.object({
  iceServers: z.array(
    z.object({
      urls: z.union([z.string(), z.array(z.string())]),
      username: z.string().optional(),
      credential: z.string().optional(),
    }),
  ),
});

export type Snapshot = z.infer<typeof snapshotSchema>;
export type Joined = z.infer<typeof joinedSchema>;
export type Description = z.infer<typeof descriptionSchema>;
export type MediaReply = z.infer<typeof mediaSchema>;
export type Track = z.infer<typeof trackSchema>;
export type Auth = { memberId: string; token: string };
export type Command =
  | { action: "create"; input: z.infer<typeof createSchema> }
  | { action: "join"; input: z.infer<typeof joinSchema> }
  | {
      action: "snapshot" | "stop" | "leave" | "end" | "ticket" | "ice";
      auth: Auth;
    }
  | { action: "publish"; auth: Auth; input: z.infer<typeof publishSchema> }
  | { action: "subscribe"; auth: Auth; input: z.infer<typeof subscribeSchema> }
  | { action: "answer"; auth: Auth; input: z.infer<typeof answerSchema> }
  | { action: "ready"; auth: Auth; input: z.infer<typeof attemptSchema> }
  | { action: "kick"; auth: Auth; input: z.infer<typeof kickSchema> }
  | { action: "invite"; auth: Auth; input: z.infer<typeof inviteSchema> };
export type RpcValue =
  | Snapshot
  | Joined
  | MediaReply
  | z.infer<typeof ticketSchema>
  | z.infer<typeof iceSchema>;
export type RpcResult =
  | { ok: true; value: RpcValue }
  | {
      ok: false;
      status: number;
      error: { code: string; message: string; retryable: boolean };
    };
