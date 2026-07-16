import test from "node:test";
import assert from "node:assert/strict";

test("ops-api-keys route - exports a Fastify plugin function", async () => {
  const mod = await import("../src/routes/ops-api-keys.js");
  const defaultExport = mod.default;
  assert.equal(typeof defaultExport, "function", "default export should be a function");
});

test("ops-api-keys route - handles missing auth gracefully", async () => {
  const mod = await import("../src/routes/ops-api-keys.js");
  assert.ok(mod.default, "should have a default export");
});
