import type { FastifyReply } from "fastify";
import type { RateLimitDecision } from "./auth.rate-limit.js";

export function applyRateLimitHeaders(reply: FastifyReply, decision: RateLimitDecision) {
  const remaining = Math.max(0, decision.limit - decision.current);
  reply.header("X-RateLimit-Limit", String(decision.limit));
  reply.header("X-RateLimit-Remaining", String(remaining));
  reply.header("X-RateLimit-Window", String(decision.windowSeconds));

  if (!decision.allowed) {
    reply.header("Retry-After", String(decision.windowSeconds));
  }
}
