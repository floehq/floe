import test from "node:test";
import assert from "node:assert/strict";

test("getInstanceId - returns hostname:port by default", async () => {
  const { getInstanceId, resetInstanceIdForTests } =
    await import("../src/services/metrics/instance.js");
  resetInstanceIdForTests();
  const id = getInstanceId();
  assert.ok(typeof id === "string");
  assert.ok(id.length > 0, "should not be empty");
  assert.ok(id.includes(":"), "should contain hostname:port format");
  resetInstanceIdForTests();
});

test("getInstanceId - returns FLOE_INSTANCE_ID when set", async () => {
  const prev = process.env.FLOE_INSTANCE_ID;
  process.env.FLOE_INSTANCE_ID = "custom-instance-123";
  try {
    const { getInstanceId, resetInstanceIdForTests } =
      await import("../src/services/metrics/instance.js");
    resetInstanceIdForTests();
    const id = getInstanceId();
    assert.equal(id, "custom-instance-123");
    resetInstanceIdForTests();
  } finally {
    if (prev === undefined) delete process.env.FLOE_INSTANCE_ID;
    else process.env.FLOE_INSTANCE_ID = prev;
  }
});

test("getInstanceLabels - returns { instance: id }", async () => {
  const { getInstanceLabels, getInstanceId, resetInstanceIdForTests } =
    await import("../src/services/metrics/instance.js");
  resetInstanceIdForTests();
  const labels = getInstanceLabels();
  assert.deepEqual(labels, { instance: getInstanceId() });
  resetInstanceIdForTests();
});

test("getInstanceInfoLabels - returns role, version, hostname", async () => {
  const { getInstanceInfoLabels, resetInstanceIdForTests } =
    await import("../src/services/metrics/instance.js");
  resetInstanceIdForTests();
  const labels = getInstanceInfoLabels();
  assert.ok(typeof labels.instance === "string");
  assert.ok(typeof labels.role === "string");
  assert.ok(typeof labels.version === "string");
  assert.ok(typeof labels.hostname === "string");
});
