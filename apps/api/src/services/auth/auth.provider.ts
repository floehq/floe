import type { FastifyRequest } from "fastify";

import { AuthModeConfig, AuthOwnerPolicyConfig } from "../../config/auth.config.js";
import type { RateLimitScope } from "../../config/auth.config.js";
import {
  checkTieredRateLimit,
  type RateLimitDecision,
} from "./auth.rate-limit.js";
import {
  authRequiredForAction,
  resolveRequestIdentity,
  type RequestIdentity,
} from "./auth.identity.js";

export interface AuthProvider {
  resolveIdentity(req: FastifyRequest): RequestIdentity;
  authorizeUploadAccess(params: {
    req: FastifyRequest;
    action: "create" | "chunk" | "status" | "complete" | "cancel";
    uploadId?: string;
    uploadOwner?: string | null;
  }): Promise<{ allowed: boolean; code?: string; message?: string }>;
  authorizeFileAccess(params: {
    req: FastifyRequest;
    action: "metadata" | "manifest" | "stream";
    fileId: string;
    fileOwner?: string | null;
  }): Promise<{ allowed: boolean; code?: string; message?: string }>;
  checkRateLimit(params: {
    req: FastifyRequest;
    scope: RateLimitScope;
  }): Promise<RateLimitDecision>;
}

class DefaultAuthProvider implements AuthProvider {
  resolveIdentity(req: FastifyRequest): RequestIdentity {
    return resolveRequestIdentity(req);
  }

  private requireAuthentication(req: FastifyRequest, action: "upload" | "file_read"): { allowed: true; identity: RequestIdentity } | { allowed: false; code: string; message: string } {
    const identity = this.resolveIdentity(req);
    if (authRequiredForAction(action) && !identity.authenticated) {
      return {
        allowed: false,
        code: "AUTH_REQUIRED",
        message:
          AuthModeConfig.mode === "private"
            ? "Authenticated access is required"
            : "Authenticated access is required for this action",
      };
    }
    return { allowed: true, identity } as const;
  }

  async authorizeUploadAccess(params: {
    req: FastifyRequest;
    action: "create" | "chunk" | "status" | "complete" | "cancel";
    uploadId?: string;
    uploadOwner?: string | null;
  }): Promise<{ allowed: boolean; code?: string; message?: string }> {
    const base = this.requireAuthentication(params.req, "upload");
    if (!base.allowed) return base;
    if (!AuthOwnerPolicyConfig.enforceUploadOwner) return { allowed: true };
    const expected = params.uploadOwner?.trim();
    if (!expected) return { allowed: true };
    const owner = base.identity.owner?.trim();
    if (!owner || owner.toLowerCase() !== expected.toLowerCase()) {
      return {
        allowed: false,
        code: "OWNER_MISMATCH",
        message: "Upload owner mismatch",
      };
    }
    return { allowed: true };
  }

  async authorizeFileAccess(params: {
    req: FastifyRequest;
    action: "metadata" | "manifest" | "stream";
    fileId: string;
    fileOwner?: string | null;
  }): Promise<{ allowed: boolean; code?: string; message?: string }> {
    const base = this.requireAuthentication(params.req, "file_read");
    if (!base.allowed) return base;
    if (!AuthOwnerPolicyConfig.enforceUploadOwner) return { allowed: true };
    const expected = params.fileOwner?.trim();
    if (!expected) return { allowed: true };
    const owner = base.identity.owner?.trim();
    if (!owner || owner.toLowerCase() !== expected.toLowerCase()) {
      return {
        allowed: false,
        code: "OWNER_MISMATCH",
        message: "File owner mismatch",
      };
    }
    return { allowed: true };
  }

  async checkRateLimit(params: {
    req: FastifyRequest;
    scope: RateLimitScope;
  }): Promise<RateLimitDecision> {
    const identity = this.resolveIdentity(params.req);
    return checkTieredRateLimit({ scope: params.scope, identity });
  }
}

export function createDefaultAuthProvider(): AuthProvider {
  return new DefaultAuthProvider();
}
