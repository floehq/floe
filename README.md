# Floe

Floe is a file upload and read platform built around Walrus, Sui, and a Tatum-backed hackathon demo flow.

This `tatum` branch keeps the core upload/read pipeline from Floe, then adds chain-aware minting, provenance, and a demo UI that makes it obvious when data came from Tatum RPC versus the local Floe index.

## What This Branch Does

- resumable chunk uploads for large files
- Walrus publish/finalize for stored blobs
- chain-aware minting for uploaded file metadata
- Tatum-backed search/index responses with explicit `source` and `rpcProvider`
- hackathon UI for uploads, chain selection, and provenance inspection

## Demo Flow

1. A user starts an upload and chooses a target chain.
2. Floe stages the chunks and finalizes the file to Walrus.
3. The finalizer picks a mint path:
   - **Tatum Express** for `polygon`, `bsc`, `celo`, and `ethereum`
   - **Tatum native minting** for `base`, `arbitrum`, `optimism`, `avalanche`, and `fantom`
4. The API stores the chain and mint provenance in the indexed file row.
5. The Tatum search route returns `source: "tatum-gateway"` when the result comes from Tatum and `rpcProvider: "tatum"` so the UI can tell the user what was used.

## Supported Mint Paths

### Tatum Express

Use this path for the fast hackathon mint flow:

- `polygon` → `MATIC`
- `bsc` / `bnb` / `binance` → `BSC`
- `celo` / `alfajores` → `CELO`
- `ethereum` / `eth` / `mainnet` → `ETH`

### Tatum Native Minting

Use this path when the chain needs a wallet-backed mint path:

- `base` → `ETH_BASE`
- `arbitrum` → `ETH_ARB`
- `optimism` → `ETH_OP`
- `avalanche` / `avax` → `AVAX`
- `fantom` → `FTM`

Native minting expects:

- `TATUM_NATIVE_CONTRACT_ADDRESS`
- `TATUM_TEST_PRIVATE_KEY` or `TATUM_SIGNATURE_ID`

Keep those credentials in test-only or hackathon-only environments.

## Local Development

### Requirements

- Node.js `>=20`
- Redis
- Walrus aggregator access
- Sui RPC access
- `TATUM_API_KEY`

For native Tatum minting, also set:

- `TATUM_NATIVE_CONTRACT_ADDRESS`
- `TATUM_TEST_PRIVATE_KEY` or `TATUM_SIGNATURE_ID`

### Install

```bash
git clone https://github.com/floehq/floe.git
cd floe
npm install
```

### Run

```bash
npm run dev
```

Hackathon UIs:

```bash
npm run tatum
npm run dashboard
```

### Build

```bash
npm run build --workspace=apps/api
```

### Tests

```bash
npm run test --workspace=apps/api
```

## API Notes

- `GET /v1/search` returns the indexed file feed.
- Tatum-backed responses include:
  - `source`
  - `rpcProvider`
- Chain metadata is stored in the indexed file row and surfaced in the dashboard.

## Documentation

- `docs/API.md` - API routes and response contract
- `docs/OPERATIONS.md` - runtime model, configuration, metrics, and runbook notes
- `npm run tatum` - hackathon demo app for uploads and provenance

## Credit

Floe started as a Sui/Walrus file pipeline. This branch keeps that core and layers Tatum-backed chain minting and search on top for the hackathon demo.

## License

MIT (`LICENSE`)
