import crypto from "crypto";
import type { FastifyRequest } from "fastify";

const SUI_ADDRESS_RE = /^(0x)?[0-9a-fA-F]{64}$/;

export type AuthMethod = "public" | "api_key" | "bearer" | "wallet" | "user_hint";

export interface RequestIdentity {
  authenticated: boolean;
  method: AuthMethod;
  subject: string;
  owner?: string;
}

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function normalizeSuiAddress(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!SUI_ADDRESS_RE.test(value)) return undefined;
  return `0x${value.replace(/^0x/i, "").toLowerCase()}`;
}

function parseBearerToken(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim();
  return token || undefined;
}

export function resolveRequestIdentity(req: FastifyRequest): RequestIdentity {
  const headers = req.headers as Record<string, unknown>;
  const walletOwner =
    normalizeSuiAddress(headers["x-wallet-address"]) ??
    normalizeSuiAddress(headers["x-owner-address"]);

  const bearer = parseBearerToken(headers.authorization);
  if (bearer) {
    return {
      authenticated: true,
      method: "bearer",
      subject: `bearer:${hashToken(bearer)}`,
      owner: walletOwner,
    };
  }

  const apiKey =
    typeof headers["x-api-key"] === "string" ? headers["x-api-key"].trim() : "";
  if (apiKey) {
    return {
      authenticated: true,
      method: "api_key",
      subject: `api_key:${hashToken(apiKey)}`,
      owner: walletOwner,
    };
  }

  const userHint =
    typeof headers["x-auth-user"] === "string" ? headers["x-auth-user"].trim() : "";
  if (userHint) {
    return {
      authenticated: true,
      method: "user_hint",
      subject: `user_hint:${userHint}`,
      owner: walletOwner,
    };
  }

  if (walletOwner) {
    return {
      authenticated: true,
      method: "wallet",
      subject: `wallet:${walletOwner}`,
      owner: walletOwner,
    };
  }

  return {
    authenticated: false,
    method: "public",
    subject: `public:${req.ip}`,
  };
}
