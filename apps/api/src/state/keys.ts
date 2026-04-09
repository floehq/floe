const PREFIX = "floe:v1";

const key = (suffix: string) => `${PREFIX}:${suffix}`;

export const uploadKeys = {
  session: (uploadId: string) => key(`upload:${uploadId}:session`),

  chunks: (uploadId: string) => key(`upload:${uploadId}:chunks`),

  meta: (uploadId: string) => key(`upload:${uploadId}:meta`),

  createIdempotency: (subject: string, idempotencyKey: string) =>
    key(`upload:create:idempotency:${subject}:${idempotencyKey}`),
  completeIdempotency: (subject: string, uploadId: string, idempotencyKey: string) =>
    key(`upload:${uploadId}:complete:idempotency:${subject}:${idempotencyKey}`),
  cancelIdempotency: (subject: string, uploadId: string, idempotencyKey: string) =>
    key(`upload:${uploadId}:cancel:idempotency:${subject}:${idempotencyKey}`),

  // GC index (single source of truth)
  gcIndex: () => key("upload:gc:active"),
  activeIndex: () => key("upload:active"),

  finalizeQueue: () => key("upload:finalize:queue"),
  finalizePending: () => key("upload:finalize:pending"),
  finalizePendingSince: () => key("upload:finalize:pending_since"),
};
