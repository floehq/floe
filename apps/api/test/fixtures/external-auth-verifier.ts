/**
 * Mock External Auth Verifier Server
 *
 * A lightweight HTTP server that implements the external auth verify
 * endpoint contract (see types/auth-external.contract.ts).
 *
 * Use in integration tests to avoid depending on a live SaaS verifier.
 *
 * Usage:
 *   const server = createMockVerifier({ port: 0 });
 *   const { port, close } = await server.start();
 *
 *   // Set expectations before each test scenario
 *   server.respondWith({ valid: true, subjectId: "test-user", ... });
 *
 *   // Point Floe at the mock:
 *   process.env.FLOE_AUTH_EXTERNAL_VERIFY_URL = `http://127.0.0.1:${port}/verify`;
 *
 *   // Clean up:
 *   await close();
 */

import http from "node:http";

export type MockVerifierResponse = {
  status?: number;
  body: Record<string, unknown>;
  delayMs?: number;
};

export type MockVerifier = {
  port: number;
  start: () => Promise<{ port: number; close: () => Promise<void> }>;
  respondWith: (response: MockVerifierResponse) => void;
  lastRequest: () => {
    method: string;
    url: string;
    body: unknown;
    headers: Record<string, string>;
  } | null;
  reset: () => void;
  close: () => Promise<void>;
};

export function createMockVerifier(options?: { port?: number }): MockVerifier {
  let response: MockVerifierResponse = {
    status: 200,
    body: { valid: true, subjectId: "mock-user", scopes: ["*"], tier: "authenticated" },
  };
  let last: { method: string; url: string; body: unknown; headers: Record<string, string> } | null =
    null;
  let server: http.Server | null = null;

  const mock: MockVerifier = {
    port: options?.port ?? 0,

    start(): Promise<{ port: number; close: () => Promise<void> }> {
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            const rawBody = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(rawBody);
            } catch {
              // Body was not JSON — that's fine, capture as-is
            }

            last = {
              method: req.method ?? "UNKNOWN",
              url: req.url ?? "/",
              body: parsed,
              headers: req.headers as Record<string, string>,
            };

            const status = response.status ?? 200;
            const delay = response.delayMs ?? 0;

            const respond = () => {
              res.writeHead(status, { "content-type": "application/json" });
              res.end(JSON.stringify(response.body));
            };

            if (delay > 0) {
              setTimeout(respond, delay);
            } else {
              respond();
            }
          });
        });

        server.listen(options?.port ?? 0, "127.0.0.1", () => {
          const addr = server?.address();
          if (addr && typeof addr === "object") {
            mock.port = addr.port;
          }
          resolve({
            port: mock.port,
            close: () => mock.close(),
          });
        });

        server.once("error", reject);
      });
    },

    respondWith(newResponse: MockVerifierResponse) {
      response = newResponse;
    },

    lastRequest() {
      return last;
    },

    reset() {
      last = null;
      response = {
        status: 200,
        body: { valid: true, subjectId: "mock-user", scopes: ["*"], tier: "authenticated" },
      };
    },

    close(): Promise<void> {
      return new Promise((resolve) => {
        if (server) {
          server.close(() => resolve());
          server = null;
        } else {
          resolve();
        }
      });
    },
  };

  return mock;
}
