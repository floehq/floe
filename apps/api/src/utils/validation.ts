/**
 * Input validation utilities for user-provided fields.
 *
 * - Filename validation: rejects path traversal, null bytes, control characters,
 *   and enforces a 255-byte maximum length.
 * - Content-Type validation: validates against a whitelist of known MIME types,
 *   with an optional env var override (FLOE_ALLOWED_CONTENT_TYPES) to extend/override
 *   the built-in list.
 */

const KNOWN_CONTENT_TYPES: ReadonlySet<string> = new Set([
  // Video
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  "video/mpeg",
  "video/3gpp",
  "video/x-flv",

  // Audio
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/x-m4a",
  "audio/x-wav",

  // Image
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "image/bmp",
  "image/tiff",
  "image/x-icon",

  // Application
  "application/pdf",
  "application/json",
  "application/octet-stream",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/xml",
  "application/x-yaml",
  "application/ld+json",
  "application/x-protobuf",
  "application/wasm",

  // Text
  "text/plain",
  "text/csv",
  "text/css",
  "text/javascript",
  "text/markdown",
]);

/**
 * Build the effective set of allowed content types.
 *
 * Merges the built-in KNOWN_CONTENT_TYPES with FLOE_ALLOWED_CONTENT_TYPES
 * (comma-separated) if the env var is set.
 */
export function getAllowedContentTypes(): ReadonlySet<string> {
  const raw = process.env.FLOE_ALLOWED_CONTENT_TYPES?.trim();
  if (!raw) return KNOWN_CONTENT_TYPES;

  const overrides = raw
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  if (overrides.length === 0) return KNOWN_CONTENT_TYPES;

  const merged = new Set(overrides);
  // If the user overrides, only use the override list (don't merge with defaults)
  // so they can tighten or expand as needed.
  return merged;
}

/**
 * Validate a filename.
 *
 * Rules:
 * - Must be a non-empty string
 * - Max 255 bytes (UTF-8 encoded)
 * - No path traversal: must not contain "..", "/", "\"
 * - No null bytes or control characters (0x00-0x1F, 0x7F)
 * - Must not be empty or whitespace-only
 *
 * Returns the validated filename on success.
 * Throws an error with a descriptive message on failure.
 */
export function validateFilename(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("filename must be a string");
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("filename must not be empty");
  }

  if (Buffer.byteLength(trimmed, "utf8") > 255) {
    throw new Error("filename must not exceed 255 bytes");
  }

  // Reject path traversal characters
  if (trimmed.includes("..")) {
    throw new Error("filename must not contain path traversal (..)");
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("filename must not contain path separators (/, \\)");
  }

  // Reject null bytes and control characters
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code === 0x00) {
      throw new Error("filename must not contain null bytes");
    }
    if (code <= 0x1f || code === 0x7f) {
      throw new Error("filename must not contain control characters");
    }
  }

  return trimmed;
}

/**
 * Validate a UUID string.
 *
 * Returns true if the value is a string matching UUID v4 format.
 * Also acts as a type guard: narrows the type to `string`.
 */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

/**
 * Validate a Content-Type value.
 *
 * Returns the validated, lowercased contentType on success.
 * Throws an error with a descriptive message on failure.
 *
 * Uses getAllowedContentTypes() to determine the allowed set,
 * so FLOE_ALLOWED_CONTENT_TYPES can override/extend the built-in list.
 */
export function validateContentType(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("contentType must be a string");
  }

  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    throw new Error("contentType must not be empty");
  }

  if (Buffer.byteLength(trimmed, "utf8") > 128) {
    throw new Error("contentType must not exceed 128 bytes");
  }

  const allowed = getAllowedContentTypes();
  if (!allowed.has(trimmed)) {
    throw new Error(
      `contentType "${trimmed}" is not in the allowed list. ` +
        "Use FLOE_ALLOWED_CONTENT_TYPES env var to add custom types.",
    );
  }

  return trimmed;
}
