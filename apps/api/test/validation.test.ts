import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateFilename, validateContentType } from "../src/utils/validation.js";

describe("validateFilename", () => {
  it("accepts valid filenames", () => {
    assert.equal(validateFilename("video.mp4"), "video.mp4");
    assert.equal(validateFilename("my-file (1).txt"), "my-file (1).txt");
    assert.equal(validateFilename("document.pdf"), "document.pdf");
    assert.equal(validateFilename("a".repeat(255)), "a".repeat(255));
  });

  it("trims whitespace", () => {
    assert.equal(validateFilename("  file.txt  "), "file.txt");
  });

  it("rejects empty strings", () => {
    assert.throws(() => validateFilename(""), /filename must not be empty/);
    assert.throws(() => validateFilename("   "), /filename must not be empty/);
  });

  it("rejects non-string input", () => {
    assert.throws(() => validateFilename(123), /filename must be a string/);
    assert.throws(() => validateFilename(null), /filename must be a string/);
    assert.throws(() => validateFilename(undefined), /filename must be a string/);
  });

  it("rejects path traversal (..)", () => {
    assert.throws(() => validateFilename("../etc/passwd"), /path traversal/);
    assert.throws(() => validateFilename("foo/../../bar"), /path traversal/);
  });

  it("rejects path separators", () => {
    assert.throws(() => validateFilename("foo/bar"), /path separators/);
    assert.throws(() => validateFilename("foo\\bar"), /path separators/);
  });

  it("rejects null bytes", () => {
    assert.throws(() => validateFilename("file\x00.txt"), /null bytes/);
  });

  it("rejects control characters", () => {
    assert.throws(() => validateFilename("file\x1f.txt"), /control characters/);
    assert.throws(() => validateFilename("file\x07.txt"), /control characters/);
    assert.throws(() => validateFilename("file\x7f.txt"), /control characters/);
  });

  it("rejects filenames exceeding 255 bytes", () => {
    assert.throws(() => validateFilename("a".repeat(256)), /255 bytes/);
  });
});

describe("validateContentType", () => {
  it("accepts known MIME types", () => {
    assert.equal(validateContentType("video/mp4"), "video/mp4");
    assert.equal(validateContentType("application/pdf"), "application/pdf");
    assert.equal(validateContentType("image/jpeg"), "image/jpeg");
    assert.equal(validateContentType("audio/mpeg"), "audio/mpeg");
    assert.equal(validateContentType("text/plain"), "text/plain");
  });

  it("normalizes to lowercase", () => {
    assert.equal(validateContentType("VIDEO/MP4"), "video/mp4");
    assert.equal(validateContentType("Application/PDF"), "application/pdf");
  });

  it("trims whitespace", () => {
    assert.equal(validateContentType("  video/mp4  "), "video/mp4");
  });

  it("rejects non-string input", () => {
    assert.throws(() => validateContentType(123), /contentType must be a string/);
    assert.throws(() => validateContentType(null), /contentType must be a string/);
  });

  it("rejects empty content types", () => {
    assert.throws(() => validateContentType(""), /contentType must not be empty/);
    assert.throws(() => validateContentType("   "), /contentType must not be empty/);
  });

  it("rejects content types exceeding 128 bytes", () => {
    assert.throws(
      () => validateContentType("a".repeat(129)),
      /contentType must not exceed 128 bytes/,
    );
  });

  it("rejects unknown MIME types", () => {
    assert.throws(() => validateContentType("text/html"), /not in the allowed list/);
    assert.throws(() => validateContentType("application/x-msdownload"), /not in the allowed list/);
    assert.throws(() => validateContentType("application/x-shockwave-flash"), /not in the allowed list/);
  });

  it("allows FLOE_ALLOWED_CONTENT_TYPES override", async () => {
    process.env.FLOE_ALLOWED_CONTENT_TYPES = "text/html,application/x-msdownload";
    // Re-import to get fresh state
    const { validateContentType: vct2, getAllowedContentTypes } = await import(
      "../src/utils/validation.js"
    );
    assert.equal(vct2("text/html"), "text/html");
    assert.equal(vct2("application/x-msdownload"), "application/x-msdownload");
    // Should NOT accept types not in the override list
    assert.throws(() => vct2("video/mp4"), /not in the allowed list/);

    // Reset
    delete process.env.FLOE_ALLOWED_CONTENT_TYPES;
  });

  it("always rejects text/html by default", () => {
    assert.throws(() => validateContentType("text/html"), /not in the allowed list/);
  });
});
