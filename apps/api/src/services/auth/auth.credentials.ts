import type { FastifyRequest } from "fastify";

import type { CredentialType } from "./auth.context.js";

export type PresentedCredential = {
  type: Exclude<CredentialType, "public">;
  value: string;
};

function parseBearerToken(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim();
  return token || undefined;
}

export function extractPresentedCredential(req: FastifyRequest): PresentedCredential | null {
  const headers = req.headers as Record<string, unknown>;
  const bearer = parseBearerToken(headers.authorization);
  if (bearer) {
    return {
      type: "bearer",
      value: bearer,
    };
  }

  const explicit = typeof headers["x-api-key"] === "string" ? headers["x-api-key"].trim() : "";
  if (explicit) {
    return {
      type: "api_key",
      value: explicit,
    };
  }

  return null;
}
