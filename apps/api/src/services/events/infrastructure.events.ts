import { parseBoolEnv } from "../../utils/parseEnv.js";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";

import { buildPublicAuthContext, type RequestIdentity } from "../auth/auth.context.js";

export type InfrastructureEventName =
  | "upload_created"
  | "chunk_uploaded"
  | "finalize_requested"
  | "upload_canceled"
  | "finalize_succeeded"
  | "finalize_failed"
  | "stream_started"
  | "stream_completed"
  | "stream_failed";

type InfrastructureEventActor = {
  authenticated: boolean;
  method: RequestIdentity["method"];
  subject: string;
  apiKeyId: string | null;
  owner: string | null;
};

export type InfrastructureEvent = {
  schemaVersion: 1;
  event: InfrastructureEventName;
  timestamp: string;
  requestId?: string;
  uploadId?: string;
  fileId?: string;
  blobId?: string;
  actor?: InfrastructureEventActor;
  statusCode?: number;
  outcome?: "success" | "failure";
  durationMs?: number;
  bytes?: number;
  metadata?: Record<string, unknown>;
};

const EVENT_LOG_ENABLED = parseBoolEnv("FLOE_EVENT_LOG_ENABLED", true);

export function requestEventActor(identity: RequestIdentity): InfrastructureEventActor {
  return {
    authenticated: identity.authenticated,
    method: identity.method,
    subject: identity.subject,
    apiKeyId: identity.keyId ?? null,
    owner: identity.owner ?? null,
  };
}

export function requestEventContext(req: FastifyRequest): {
  requestId: string;
  actor: InfrastructureEventActor;
} {
  const identity = req.authContext ?? buildPublicAuthContext(req);
  return {
    requestId: req.id,
    actor: requestEventActor(identity),
  };
}

export function emitInfrastructureEvent(
  log: FastifyBaseLogger | Pick<Console, "info">,
  event: Omit<InfrastructureEvent, "schemaVersion" | "timestamp">,
) {
  if (!EVENT_LOG_ENABLED) return;
  log.info({
    infraEvent: {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      ...event,
    } satisfies InfrastructureEvent,
  });
}
