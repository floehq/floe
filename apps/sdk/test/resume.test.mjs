import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createNodeFileResumeStore } from "../dist/index.js";

test("node file resume store persists and removes upload ids", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "floe-sdk-resume-"));
  const filePath = path.join(dir, "resume.json");
  const store = await createNodeFileResumeStore({ filePath });

  assert.equal(await store.get("alpha"), null);

  await store.set("alpha", "upload_1");
  assert.equal(await store.get("alpha"), "upload_1");

  await store.remove("alpha");
  assert.equal(await store.get("alpha"), null);
});
