import type { FastifyRequest } from "fastify";

import {
  AuthAccessPolicyConfig,
  AuthOwnerPolicyConfig,
} from "../../config/auth.config.js";
import type { RateLimitScope } from "../../config/auth.config.js";
import {
  checkTieredRateLimit,
  type RateLimitDecision,
} from "./auth.rate-limit.js";
import {
  resolveRequestIdentity,
} from "./auth.identity.js";
import {
  authRequiredForAction,
  type RequestIdentity,
} from "./auth.context.js";

export interface AuthProvider {
  resolveIdentity(req: FastifyRequest): Promise<RequestIdentity>;
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
  authorizeOpsAccess(params: {
    req: FastifyRequest;
    action: "upload_read" | "upload_admin";
  }): Promise<{ allowed: boolean; code?: string; message?: string }>;
  checkRateLimit(params: {
    req: FastifyRequest;
    scope: RateLimitScope;
  }): Promise<RateLimitDecision>;
}

class DefaultAuthProvider implements AuthProvider {
  async resolveIdentity(req: FastifyRequest): Promise<RequestIdentity> {
    const resolved = await resolveRequestIdentity(req);
    (req as FastifyRequest & { authContext?: RequestIdentity }).authContext = resolved;
    return resolved;
  }

  private hasScope(identity: RequestIdentity, requiredScope: string): boolean {
    if (!identity.authenticated) return false;
    if (identity.scopes.includes("*")) return true;
    return identity.scopes.includes(requiredScope);
  }

  private requireScope(identity: RequestIdentity, requiredScope: string): { allowed: true } | { allowed: false; code: string; message: string } {
    if (this.hasScope(identity, requiredScope)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      code: "INSUFFICIENT_SCOPE",
      message: `API key is missing required scope: ${requiredScope}`,
    };
  }

  private requireAnyScope(
    identity: RequestIdentity,
    requiredScopes: string[]
  ): { allowed: true } | { allowed: false; code: string; message: string } {
    if (requiredScopes.some((scope) => this.hasScope(identity, scope))) {
      return { allowed: true };
    }
    return {
      allowed: false,
      code: "INSUFFICIENT_SCOPE",
      message: `Authenticated principal is missing required scope: ${requiredScopes[0]}`,
    };
  }

  private async requireAuthentication(
    req: FastifyRequest,
    action: "upload" | "file_read"
  ): Promise<
    { allowed: true; identity: RequestIdentity } | { allowed: false; code: string; message: string }
  > {
    const identity = await this.resolveIdentity(req);
    if (authRequiredForAction(action) && !identity.authenticated) {
      return {
        allowed: false,
        code: "AUTH_REQUIRED",
        message:
          AuthAccessPolicyConfig.policy === "private"
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
    const base = await this.requireAuthentication(params.req, "upload");
    if (!base.allowed) return base;
    if (base.identity.authenticated) {
      const scope = params.action === "status" ? "uploads:read" : "uploads:write";
      const scopeCheck = this.requireScope(base.identity, scope);
      if (!scopeCheck.allowed) return scopeCheck;
    }
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
    const base = await this.requireAuthentication(params.req, "file_read");
    if (!base.allowed) return base;
    if (base.identity.authenticated) {
      const scopeCheck = this.requireScope(base.identity, "files:read");
      if (!scopeCheck.allowed) return scopeCheck;
    }
    if (!AuthOwnerPolicyConfig.enforceUploadOwner) return { allowed: true };
    const expected = params.fileOwner?.trim();
    if (!expected && !base.identity.authenticated) {
      return {
        allowed: false,
        code: "AUTH_REQUIRED",
        message: "Authenticated access is required for owner-protected file reads",
      };
    }
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

  async authorizeOpsAccess(params: {
    req: FastifyRequest;
    action: "upload_read" | "upload_admin";
  }): Promise<{ allowed: boolean; code?: string; message?: string }> {
    const identity = await this.resolveIdentity(params.req);
    if (!identity.authenticated) {
      return {
        allowed: false,
        code: "AUTH_REQUIRED",
        message: "Authenticated operator access is required",
      };
    }

    if (params.action === "upload_admin") {
      return this.requireAnyScope(identity, ["admin:uploads"]);
    }

    return this.requireAnyScope(identity, ["ops:read", "admin:uploads"]);
  }

  async checkRateLimit(params: {
    req: FastifyRequest;
    scope: RateLimitScope;
  }): Promise<RateLimitDecision> {
    const identity = await this.resolveIdentity(params.req);
    return checkTieredRateLimit({ scope: params.scope, identity });
  }
}

export function createDefaultAuthProvider(): AuthProvider {
  return new DefaultAuthProvider();
}
