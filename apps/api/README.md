# @floe/api

The Floe API server: resumable chunk uploads with S3 storage, Walrus blob publish, and Sui metadata finalization.

## Quick Start

```bash
# From repo root
npm install
docker compose up -d

# From apps/api
cp ../../.env.example ../../.env
npm run dev
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with hot reload |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled output |
| `npm test` | Run all tests with coverage |
| `npm run lint` | ESLint + Prettier check |

## Source Structure

```
src/
├── server.ts         # Entry point
├── app.server.ts     # Fastify app setup and plugin registration
├── version.ts        # Version constant
├── routes/           # Route handlers (uploads, files, health, ops)
├── services/         # Business logic modules
│   ├── auth/         # Authentication and API key management
│   ├── metrics/      # Prometheus metrics
│   ├── uploads/      # Upload finalization worker
│   ├── events/       # Infrastructure event system
│   ├── walrus/       # Walrus blob publishing
│   ├── files/        # File management
│   ├── health/       # Health checks
│   ├── ops/          # Operations endpoints
│   ├── stream/       # Stream handling
│   ├── circuit-breaker/ # Circuit breaker patterns
│   ├── errors/       # Error handling
│   └── reliability/  # Reliability utilities
├── store/            # S3 chunk storage
├── sui/              # Sui blockchain interaction
├── state/            # Application state
├── config/           # Configuration loading
├── db/               # Postgres queries
├── types/            # TypeScript type definitions
├── floe-move/        # Sui move package utilities
└── utils/            # Shared utilities
```

## Key Config Files

- `../../.env` — environment variables (see `../../.env.example`)
- `../../docker-compose.yml` — local infrastructure (Postgres, Redis, MinIO)

## Testing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full testing guide.
