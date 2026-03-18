import type { FastifyRequest } from "fastify";

import { AuthOwnerPolicyConfig } from "../../config/auth.config.js";
import type { RateLimitScope } from "../../config/auth.config.js";
import {
  checkTieredRateLimit,
  type RateLimitDecision,
} from "./auth.rate-limit.js";
import {
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

  async authorizeUploadAccess(params: {
    req: FastifyRequest;
    action: "create" | "chunk" | "status" | "complete" | "cancel";
    uploadId?: string;
    uploadOwner?: string | null;
  }): Promise<{ allowed: boolean; code?: string; message?: string }> {
    if (!AuthOwnerPolicyConfig.enforceUploadOwner) return { allowed: true };
    const expected = params.uploadOwner?.trim();
    if (!expected) return { allowed: true };

    const identity = this.resolveIdentity(params.req);
    const owner = identity.owner?.trim();
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
    if (!AuthOwnerPolicyConfig.enforceUploadOwner) return { allowed: true };
    const expected = params.fileOwner?.trim();
    if (!expected) return { allowed: true };
    const identity = this.resolveIdentity(params.req);
    const owner = identity.owner?.trim();
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
    return checkTieredRateLimit(params);
  }
}

export function createDefaultAuthProvider(): AuthProvider {
  return new DefaultAuthProvider();
}
