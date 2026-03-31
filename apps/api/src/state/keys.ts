const PREFIX = "floe:v1";

const key = (suffix: string) => `${PREFIX}:${suffix}`;

export const uploadKeys = {
  session: (uploadId: string) => key(`upload:${uploadId}:session`),

  chunks: (uploadId: string) => key(`upload:${uploadId}:chunks`),

  meta: (uploadId: string) => key(`upload:${uploadId}:meta`),

  // GC index (single source of truth)
  gcIndex: () => key("upload:gc:active"),
  activeIndex: () => key("upload:active"),

  finalizeQueue: () => key("upload:finalize:queue"),
  finalizePending: () => key("upload:finalize:pending"),
  finalizePendingSince: () => key("upload:finalize:pending_since"),
};
