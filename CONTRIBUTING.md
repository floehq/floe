# Contributing to Floe

## Development Setup

1. **Prerequisites:**
   - Node.js 20+
   - npm 9+
   - Docker and Docker Compose
   - Walrus aggregator access
   - Sui RPC access and a signing key

2. **Clone and install:**
   ```bash
   git clone https://github.com/floehq/floe.git
   cd floe
   npm ci
   ```

3. **Start infrastructure:**
   ```bash
   docker compose up -d
   ```

4. **Configure environment:**
   ```bash
   cp .env.example .env
   ```
   Set `FLOE_REDIS_PROVIDER=native`, `REDIS_URL=redis://127.0.0.1:6379`, your Sui keys, and a test API key. See [Quick Start](../README.md#quick-start) for the minimum required variables.

5. **Run the server:**
   ```bash
   npm run dev
   ```

## Code Style

- **TypeScript strict mode** is enabled. Keep it on.
- **Prettier** is configured at the project root. Run `npm run prettier` before committing.
- **ESLint** is configured with TypeScript rules. Run `npm run lint --workspace=apps/api` to check.
- **Semicolons** are required.
- **Double quotes** are required (except to avoid escaping).
- **No explicit `any`** — prefer `unknown` with proper type narrowing. Warnings are tolerated in legacy code but should be removed in new code.

## Testing

### Test Framework

Tests use the **Node.js built-in test runner** (`node:test`) with `tsx` as the TypeScript loader. No Jest, Vitest, or Mocha.

### Running Tests

| Command | Description |
| --- | --- |
| `npm test --workspace=apps/api` | All tests (includes `--experimental-test-coverage`) |
| `npx tsx --test ./test/validation.test.ts` | Single file |
| `npx tsx --test --no-coverage ./test/*.test.ts` | All tests without coverage |

### Test Categories

- **Unit tests** (`*.test.ts`) — no external dependencies, run anywhere. Mock all I/O.
- **Integration tests** (`*.integration.test.ts`) — require one or more of: Redis, Postgres, MinIO (S3-compatible). Many spawn their own Redis on a random port (see `upload.integration.test.ts`).

### Test File Map

| File | Subsystem | Type |
|---|---|---|
| `auth.api-key-store-interface.test.ts` | Auth — API key store interface contract | Unit |
| `auth.api-key.pg.test.ts` | Auth — Postgres API key store | Unit |
| `auth.api-key.pg.integration.test.ts` | Auth — Postgres API key store (real Postgres) | Integration |
| `auth.headers.test.ts` | Auth — Rate-limit header formatting | Unit |
| `auth.identity.test.ts` | Auth — Identity resolution | Unit |
| `auth.provider.test.ts` | Auth — Auth providers (local, external) | Unit |
| `auth.rate-limit.test.ts` | Auth — Rate limiting logic | Unit |
| `circuit-breaker.test.ts` | Infrastructure — Circuit breaker state machine | Unit |
| `circuit-breaker.integration.test.ts` | Infrastructure — Circuit breaker with upstream services | Integration |
| `db.test.ts` | Database — Connection and query helpers | Unit |
| `files.integration.test.ts` | Files — Upload-to-finalize end-to-end flow | Integration |
| `finalize.integration.test.ts` | Finalize — File metadata finalization (spawns Redis) | Integration |
| `finalize.service.test.ts` | Finalize — Finalize pipeline logic (dependency injection) | Unit |
| `finalize.shared.test.ts` | Finalize — Shared utilities | Unit |
| `gc.test.ts` | Garbage collection — Expired session cleanup | Unit |
| `gc-subsystem.test.ts` | GC — Upload GC scheduler, reconciliation, distributed locking | Unit |
| `metrics-instance.test.ts` | Metrics — Instance-level metrics | Unit |
| `ops-api-keys.test.ts` | Ops — Admin API key management routes | Unit |
| `ops-api-keys.lifecycle.test.ts` | Ops — API key create/rotate/revoke lifecycle | Unit |
| `redis.adapter.test.ts` | Redis — Adapter abstraction layer | Unit |
| `redis.native.test.ts` | Redis — Native client wrapper | Unit |
| `runtime.bootstrap.test.ts` | Runtime — Server bootstrap and startup | Unit |
| `s3.state.test.ts` | S3 — Connection state management | Unit |
| `s3.store.test.ts` | S3 — Chunk store (unit) | Unit |
| `s3.store.integration.test.ts` | S3 — Chunk store (real MinIO/S3) | Integration |
| `spool-bench.test.ts` | Spool — Benchmark / performance test | Unit |
| `state.test.ts` | State — Global state management | Unit |
| `stream-cache.test.ts` | Streaming — Cache truncation, abort, error propagation | Unit |
| `stream-cache-advanced.test.ts` | Streaming — Concurrency, LRU eviction, dedup | Unit |
| `stream-hardening.test.ts` | Streaming — Content-Range validation, orphan cleanup, pruning | Unit |
| `stream-route-abort.test.ts` | Streaming — Route abort and cancellation behavior | Unit |
| `sui-metadata-metrics.test.ts` | Sui — Metadata minting metrics | Unit |
| `sui.signer.test.ts` | Sui — Transaction signer | Unit |
| `sui.signer.kms.test.ts` | Sui — KMS-backed transaction signer | Unit |
| `topology.config.test.ts` | Config — Topology / deployment config parsing | Unit |
| `upload.integration.test.ts` | Upload — Chunked upload flow (spawns Redis) | Integration |
| `upload-error-paths.test.ts` | Upload — Error paths and edge cases | Unit |
| `validation.test.ts` | Validation — Filename, content-type, config validation | Unit |
| `walrus.test.ts` | Walrus — Blob store client | Unit |
| `walrus-backends.test.ts` | Walrus — Backend implementations (SDK, publisher, CLI) | Unit |
| `walrus-read.test.ts` | Walrus — Read path, segment retry, idle timeout | Unit |
| `walrus-upload.test.ts` | Walrus — Upload/publish path | Unit |

### Integration Test Setup

Start the required infrastructure before running integration tests:

```bash
docker compose -f docker-compose.test.yml up -d
```

This starts Redis and Postgres. Set the following environment variables:

```bash
export FLOE_API_KEY_STORE=postgres
export FLOE_AUTH_PROVIDER=local
export DATABASE_URL=postgresql://floe_test:floe_test@localhost:5432/floe_test
export REDIS_URL=redis://localhost:6379
export FLOE_S3_ENDPOINT=http://localhost:9000
export FLOE_S3_BUCKET=floe-test
export FLOE_S3_ACCESS_KEY_ID=minioadmin
export FLOE_S3_SECRET_ACCESS_KEY=minioadmin
```

Or copy `.env.integration.example` to `.env` and source it. Some integration tests (e.g., `upload.integration.test.ts`, `finalize.integration.test.ts`) spawn their own Redis on a random port and do not need a running instance.

### Writing New Tests

- Follow existing patterns in `apps/api/test/`.
- Use `node:test` primitives: `describe`, `it`, `test`, `before`, `after`, `beforeEach`, `afterEach`.
- Use `node:assert/strict` for assertions.
- Run tests with `npx tsx --test` (NOT vitest).
- Integration tests that need Redis should spawn their own instance on a random port (pattern from `upload.integration.test.ts`) to avoid port conflicts in parallel runs.
- Place test helpers in `test/fixtures/`.
- **Coverage target:** 80%+ on auth, upload routes, and finalize service.

### CI Pipeline

GitHub Actions runs four parallel jobs on every push/PR:

1. **Lint** — ESLint + Prettier across the API, SDK, and CLI workspaces.
2. **Typecheck** — TypeScript type-checking for the API, SDK, and CLI.
3. **Unit Tests** — `node:test` with `tsx` on all non-integration test files.
4. **Integration Tests** — Postgres + Redis service containers; runs `*.integration.test.ts` files.

All four jobs must pass before a PR can be merged.

## Pull Request Process

1. Create a feature branch from `main`.
2. Make your changes, keeping them focused and reviewable.
3. Run the full test suite: `npm test --workspace=apps/api`
4. Run the linter: `npm run lint --workspace=apps/api`
5. Ensure TypeScript compiles: `npm run build --workspace=apps/api`
6. Submit a PR with a clear description of what and why.
7. All CI jobs must be green (Lint, Typecheck, Unit Tests, Integration Tests).

## Commit Messages

Follow conventional commits format:
- `feat:` — new feature
- `fix:` — bug fix
- `perf:` — performance improvement
- `refactor:` — code restructuring
- `test:` — adding or updating tests
- `docs:` — documentation only
- `chore:` — maintenance, dependencies, CI

## Project Structure

```
apps/api/       — Fastify API server
apps/sdk/       — TypeScript SDK for clients
apps/cli/       — CLI tool
config/         — Example configuration files
docs/           — Documentation
scripts/        — Utility scripts
```

## Questions?

Open a GitHub Discussion or check `docs/` for detailed documentation.
