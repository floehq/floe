# Tatum Hackathon Branch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `tatum` branch into a clean hackathon-focused Floe demo with explicit Tatum multi-chain minting, Walrus-backed uploads, and a README that explains the demo flow clearly.

**Architecture:** Keep `main` unchanged and make `tatum` the demo branch. The API keeps the same upload/read surface, but chain selection is routed through a Tatum-aware mint provider so supported chains use NFT Express and Base/native chains use a test wallet path. The Tatum search/index route should surface the real Tatum-backed source so the dashboard and README can explain exactly what service is being used.

**Tech Stack:** TypeScript, Fastify, Redis, Postgres, Walrus, Sui, Tatum REST APIs, Node.js.

---

### Task 1: Prune branch leftovers and normalize demo entrypoints

**Files:**
- Modify: `package.json`
- Delete: `docs/knowledge-graph.json`
- Delete: `docs/knowledge-graph.md`

- [ ] **Step 1: Remove unrelated knowledge-graph artifacts**

Delete the two knowledge-graph files so the branch does not advertise unrelated plugin-generated material.

- [ ] **Step 2: Fix the root dashboard script**

Update the root workspace script so `npm run dashboard` starts the dashboard app instead of the Tatum app.

- [ ] **Step 3: Verify the branch surface matches the hackathon story**

Run: `git status --short --branch`

Expected: only the intended Tatum demo work remains dirty.

### Task 2: Add explicit Tatum multi-chain mint routing

**Files:**
- Create: `apps/api/src/services/tatum/mint.provider.ts`
- Modify: `apps/api/src/services/tatum/anchor.ts`
- Modify: `apps/api/src/services/uploads/finalize.service.ts`
- Modify: `apps/api/src/routes/uploads.ts`
- Modify: `apps/api/src/types/upload.ts`
- Modify: `apps/api/src/db/files.repository.ts`

- [ ] **Step 1: Write a failing routing test**

Add a focused API test that creates an upload for `base` and one supported NFT Express chain, then asserts the finalized record stores the chosen chain and provider mode.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm --prefix apps/api test -- --runInBand <the new test file>`

Expected: fail because the mint-routing abstraction does not exist yet.

- [ ] **Step 3: Implement the minimal chain router**

Add a small provider selector that returns:
- `tatum-express` for supported NFT Express chains
- `tatum-native` for Base and other native-supported chains

Use Tatum env config for the test wallet path, and keep the provider decision explicit in the finalized file record.

- [ ] **Step 4: Wire finalize to the provider**

Update finalize so the chosen provider is used when anchoring/minting, and persist the chain/provider fields in the indexed file row.

- [ ] **Step 5: Run the targeted test again**

Run: `npm --prefix apps/api test -- --runInBand <the new test file>`

Expected: PASS.

### Task 3: Make the Tatum search/index route tell the truth

**Files:**
- Modify: `apps/api/src/services/tatum/indexer.ts`
- Modify: `apps/api/src/routes/tatum.ts`
- Modify: `apps/api/src/routes/files.ts`
- Modify: `apps/api/src/sui/file.metadata.ts`
- Modify: `apps/api/src/services/tatum/anchor.ts`

- [ ] **Step 1: Write a failing search metadata test**

Add a test that hits the Tatum search route and expects the response to expose the actual source/provider metadata instead of a generic placeholder.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm --prefix apps/api test -- --runInBand <the new search test>`

Expected: fail because the route still returns the old generic source model.

- [ ] **Step 3: Implement the Tatum-backed search shape**

Change the route and indexer so the response states whether data came from Tatum gateway/indexed DB and includes chain-aware provenance fields that the dashboard can render.

- [ ] **Step 4: Run the targeted test again**

Run: `npm --prefix apps/api test -- --runInBand <the new search test>`

Expected: PASS.

### Task 4: Rewrite the branch README for the hackathon demo

**Files:**
- Modify: `README.md`
- Modify: `docs/API.md`
- Modify: `docs/OPERATIONS.md`

- [ ] **Step 1: Write the README first-draft**

Rewrite the README around:
- hackathon demo goals
- Tatum + Walrus flow
- supported chains and provider mode
- how to run `npm run tatum`
- how the user sees whether Tatum RPC/explorer data is being used

- [ ] **Step 2: Update API/operations docs to match the demo**

Make the docs mention the new chain/provider metadata and the branch-specific demo path.

- [ ] **Step 3: Review the README for mixed messaging**

Check that it clearly says this branch is the demo branch and that `main` remains the generic Floe codebase.

### Task 5: Verify and commit the branch

**Files:**
- All files changed above

- [ ] **Step 1: Run the API build**

Run: `npm --prefix apps/api run build`

Expected: exit code 0.

- [ ] **Step 2: Run the API tests**

Run: `npm --prefix apps/api test`

Expected: all tests pass.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --stat`

Expected: only the intended Tatum hackathon refactor and documentation changes remain.

- [ ] **Step 4: Commit the branch**

Run: `git add -A && git commit -m "feat: shape tatum branch for hackathon demo"`

