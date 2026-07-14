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
  | "stream_failed"
  // Audit events
  | "audit_admin_action"
  | "audit_config_change"
  | "audit_permission_change"
  | "audit_key_rotation";

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
  // Audit-specific fields for state mutation tracking
  auditAction?: string;
  auditResource?: string;
  auditBefore?: Record<string, unknown> | null;
  auditAfter?: Record<string, unknown> | null;
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

/**
 * Emit a standard infrastructure lifecycle event.
 * Written as structured JSON under the `infraEvent` key.
 */
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

/**
 * Emit an audit event — a special category of infrastructure event
 * that captures state-mutating actions with before/after snapshots.
 *
 * These are logged at the `warn` level so they are never suppressed
 * by log level filtering in production.
 */
export function emitAuditEvent(
  log: FastifyBaseLogger | Pick<Console, "info" | "warn">,
  params: {
    action: string;
    resource: string;
    actor: InfrastructureEventActor;
    requestId?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
  },
) {
  if (!EVENT_LOG_ENABLED) return;
  const auditEvent: InfrastructureEvent = {
    schemaVersion: 1,
    event: "audit_admin_action",
    timestamp: new Date().toISOString(),
    requestId: params.requestId,
    actor: params.actor,
    auditAction: params.action,
    auditResource: params.resource,
    auditBefore: params.before ?? null,
    auditAfter: params.after ?? null,
    metadata: params.metadata,
    outcome: "success",
  };

  // Audit events use `warn` level so they are never suppressed.
  log.warn({ auditEvent });
}
