import test from "node:test";
import assert from "node:assert/strict";

import { isS3BucketMissingError } from "../src/state/s3.ts";

test("isS3BucketMissingError only treats missing-bucket responses as creatable", () => {
  assert.equal(isS3BucketMissingError({ name: "NotFound" }), true);
  assert.equal(isS3BucketMissingError({ Code: "NoSuchBucket" }), true);
  assert.equal(isS3BucketMissingError({ $metadata: { httpStatusCode: 404 } }), true);

  assert.equal(isS3BucketMissingError({ name: "Forbidden" }), false);
  assert.equal(isS3BucketMissingError({ Code: "AccessDenied" }), false);
  assert.equal(isS3BucketMissingError({ $metadata: { httpStatusCode: 403 } }), false);
  assert.equal(isS3BucketMissingError(new Error("socket hang up")), false);
});
