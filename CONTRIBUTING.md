# Contributing to Floe

## Development Setup

1. **Prerequisites:**
   - Node.js 20+
   - npm 9+
   - Redis (for local testing)
   - Docker (optional, for Postgres tests)

2. **Clone and install:**
   ```bash
   git clone https://github.com/floehq/floe.git
   cd floe
   npm ci
   ```

3. **Environment:**
   - Copy `config/floe.example.yaml` to `config/floe.yaml` and adjust for your setup.
   - Key env vars are documented in `docs/OPERATIONS.md`.

## Code Style

- **TypeScript strict mode** is enabled. Keep it on.
- **Prettier** is configured at the project root. Run `npm run prettier` before committing.
- **ESLint** is configured with TypeScript rules. Run `npm run lint --workspace=apps/api` to check.
- **Semicolons** are required.
- **Double quotes** are required (except to avoid escaping).
- **No explicit `any`** — prefer `unknown` with proper type narrowing. Warnings are tolerated in legacy code but should be removed in new code.

## Testing

- **Unit tests** use Node.js native `node:test` runner with `tsx` loader.
- Run all tests: `npm test --workspace=apps/api`
- Run a specific test file: `node --import tsx --test test/validation.test.ts`
- **Integration tests** require Redis running locally.
- **Coverage target:** 80%+ on auth, upload routes, and finalize service.

## Pull Request Process

1. Create a feature branch from `main`.
2. Make your changes, keeping them focused and reviewable.
3. Run the full test suite: `npm test --workspace=apps/api`
4. Run the linter: `npm run lint --workspace=apps/api`
5. Ensure TypeScript compiles: `npm run build --workspace=apps/api`
6. Submit a PR with a clear description of what and why.

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
