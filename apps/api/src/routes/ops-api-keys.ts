import type { FastifyInstance } from "fastify";
import { sendApiError } from "../utils/apiError.js";
import { TopologyConfig } from "../config/topology.config.js";
import { emitAuditEvent, requestEventContext } from "../services/events/infrastructure.events.js";
import { getApiKeyStore } from "../services/auth/auth.api-key.js";

function authzStatusCode(code?: string): 401 | 403 {
  return code === "AUTH_REQUIRED" ? 401 : 403;
}

function authzErrorCode(code?: string): "AUTH_REQUIRED" | "INSUFFICIENT_SCOPE" {
  if (code === "AUTH_REQUIRED") return "AUTH_REQUIRED";
  return "INSUFFICIENT_SCOPE";
}

export default async function opsApiKeysRoutes(app: FastifyInstance) {
  if (!TopologyConfig.routes.ops) return;

  const store = getApiKeyStore();

  app.get("/ops/api-keys", async (req, reply) => {
    const authz = await req.server.authProvider.authorizeOpsAccess({
      req,
      action: "upload_admin",
    });
    if (!authz.allowed) {
      return sendApiError(
        reply,
        authzStatusCode(authz.code),
        authzErrorCode(authz.code),
        authz.message ?? "Operator access denied",
      );
    }

    const keys = await store.listActive();
    return reply.code(200).send({
      keys: keys.map((k) => ({
        id: k.id,
        owner: k.owner ?? null,
        scopes: k.scopes,
        tier: k.tier,
      })),
      count: keys.length,
    });
  });

  app.post("/ops/api-keys", async (req, reply) => {
    if (!store.supportsLifecycle) {
      return sendApiError(
        reply,
        501,
        "DEPENDENCY_UNAVAILABLE",
        "API key lifecycle management requires FLOE_API_KEY_STORE=postgres",
      );
    }

    const authz = await req.server.authProvider.authorizeOpsAccess({
      req,
      action: "upload_admin",
    });
    if (!authz.allowed) {
      return sendApiError(
        reply,
        authzStatusCode(authz.code),
        authzErrorCode(authz.code),
        authz.message ?? "Operator access denied",
      );
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const owner = typeof body.owner === "string" ? body.owner : undefined;

    if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
      return sendApiError(
        reply,
        400,
        "INVALID_REQUEST_BODY",
        "scopes is required and must be a non-empty array of strings",
      );
    }
    const scopes = body.scopes.filter((s): s is string => typeof s === "string");
    if (scopes.length === 0) {
      return sendApiError(
        reply,
        400,
        "INVALID_REQUEST_BODY",
        "scopes must contain at least one valid string",
      );
    }

    const tier = body.tier === "public" ? "public" : ("authenticated" as const);

    const result = await store.create({ owner, scopes, tier });

    emitAuditEvent(req.childLogger, {
      action: "api_key_created",
      resource: `api_key:${result.id}`,
      actor: requestEventContext(req).actor,
      requestId: req.id,
      before: null,
      after: { id: result.id, owner: owner ?? null, scopes, tier },
      metadata: { action: "create_api_key" },
    });

    return reply.code(201).send({
      id: result.id,
      secret: result.secret,
      owner: owner ?? null,
      scopes,
      tier,
      createdAt: result.createdAt.toISOString(),
      message: "Store this secret — it will not be shown again",
    });
  });

  app.delete("/ops/api-keys/:keyId", async (req, reply) => {
    if (!store.supportsLifecycle) {
      return sendApiError(
        reply,
        501,
        "DEPENDENCY_UNAVAILABLE",
        "API key lifecycle management requires FLOE_API_KEY_STORE=postgres",
      );
    }

    const authz = await req.server.authProvider.authorizeOpsAccess({
      req,
      action: "upload_admin",
    });
    if (!authz.allowed) {
      return sendApiError(
        reply,
        authzStatusCode(authz.code),
        authzErrorCode(authz.code),
        authz.message ?? "Operator access denied",
      );
    }

    const { keyId } = req.params as { keyId: string };
    if (!keyId || keyId.length > 128) {
      return sendApiError(reply, 400, "INVALID_REQUEST_BODY", "Invalid key ID");
    }

    const revoked = await store.revoke(keyId);
    if (!revoked) {
      return sendApiError(reply, 404, "API_KEY_NOT_FOUND", "API key not found or already revoked");
    }

    emitAuditEvent(req.childLogger, {
      action: "api_key_revoked",
      resource: `api_key:${keyId}`,
      actor: requestEventContext(req).actor,
      requestId: req.id,
      before: { id: keyId },
      after: null,
      metadata: { action: "revoke_api_key" },
    });

    return reply.code(200).send({ id: keyId, revoked: true });
  });

  app.post("/ops/api-keys/:keyId/rotate", async (req, reply) => {
    if (!store.supportsLifecycle) {
      return sendApiError(
        reply,
        501,
        "DEPENDENCY_UNAVAILABLE",
        "API key lifecycle management requires FLOE_API_KEY_STORE=postgres",
      );
    }

    const authz = await req.server.authProvider.authorizeOpsAccess({
      req,
      action: "upload_admin",
    });
    if (!authz.allowed) {
      return sendApiError(
        reply,
        authzStatusCode(authz.code),
        authzErrorCode(authz.code),
        authz.message ?? "Operator access denied",
      );
    }

    const { keyId } = req.params as { keyId: string };
    if (!keyId || keyId.length > 128) {
      return sendApiError(reply, 400, "INVALID_REQUEST_BODY", "Invalid key ID");
    }

    try {
      const result = await store.rotate(keyId);

      emitAuditEvent(req.childLogger, {
        action: "api_key_rotated",
        resource: `api_key:${keyId}`,
        actor: requestEventContext(req).actor,
        requestId: req.id,
        before: { id: keyId },
        after: { id: result.id },
        metadata: { action: "rotate_api_key" },
      });

      return reply.code(200).send({
        id: result.id,
        secret: result.secret,
        rotatedAt: result.rotatedAt.toISOString(),
        message: "Store this secret — it will not be shown again",
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        return sendApiError(
          reply,
          404,
          "API_KEY_NOT_FOUND",
          "API key not found or already revoked",
        );
      }
      throw err;
    }
  });
}
