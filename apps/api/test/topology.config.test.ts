import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTopologyConfig,
  parseTopologyNodeRole,
} from "../src/config/topology.config.ts";

test("buildTopologyConfig exposes read-node capabilities", () => {
  const topology = buildTopologyConfig("read");

  assert.equal(topology.role, "read");
  assert.equal(topology.routes.uploads, false);
  assert.equal(topology.routes.files, true);
  assert.equal(topology.routes.ops, false);
  assert.equal(topology.workers.finalize, false);
  assert.equal(topology.features.streamCache, true);
});

test("buildTopologyConfig exposes write-node capabilities", () => {
  const topology = buildTopologyConfig("write");

  assert.equal(topology.role, "write");
  assert.equal(topology.routes.uploads, true);
  assert.equal(topology.routes.files, false);
  assert.equal(topology.routes.ops, true);
  assert.equal(topology.workers.finalize, true);
  assert.equal(topology.features.streamCache, false);
});

test("buildTopologyConfig exposes full-node capabilities", () => {
  const topology = buildTopologyConfig("full");

  assert.equal(topology.role, "full");
  assert.equal(topology.routes.uploads, true);
  assert.equal(topology.routes.files, true);
  assert.equal(topology.routes.ops, true);
  assert.equal(topology.workers.finalize, true);
  assert.equal(topology.features.streamCache, true);
});

test("parseTopologyNodeRole rejects invalid roles", () => {
  assert.throws(() => parseTopologyNodeRole("edge"), /FLOE_NODE_ROLE/);
});
