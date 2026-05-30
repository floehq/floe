import test from "node:test";
import assert from "node:assert/strict";

import { resolveTatumMintRoute } from "../src/services/tatum/mint.provider.js";

test("uses NFT Express for Polygon", () => {
  const route = resolveTatumMintRoute("polygon");

  assert.equal(route.mode, "express");
  assert.equal(route.chain, "MATIC");
  assert.equal(route.requiresPrivateKey, false);
});

test("uses native minting for Base", () => {
  const route = resolveTatumMintRoute("base");

  assert.equal(route.mode, "native");
  assert.equal(route.chain, "ETH_BASE");
  assert.equal(route.requiresPrivateKey, true);
});
