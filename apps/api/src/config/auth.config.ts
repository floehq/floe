function parsePositiveIntEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return n;
}

const LIMIT_DEFAULTS = {
  upload_control: {
    public: 5,
    authenticated: 120,
  },
  upload_chunk: {
    public: 30,
    authenticated: 1200,
  },
  file_meta_read: {
    public: 240,
    authenticated: 2400,
  },
  file_stream_read: {
    public: 120,
    authenticated: 1200,
  },
} as const;

const LIMIT_ENV = {
  upload_control: {
    public: "FLOE_RATE_LIMIT_UPLOAD_CONTROL_PUBLIC",
    authenticated: "FLOE_RATE_LIMIT_UPLOAD_CONTROL_AUTH",
  },
  upload_chunk: {
    public: "FLOE_RATE_LIMIT_UPLOAD_CHUNK_PUBLIC",
    authenticated: "FLOE_RATE_LIMIT_UPLOAD_CHUNK_AUTH",
  },
  file_meta_read: {
    public: "FLOE_RATE_LIMIT_FILE_META_PUBLIC",
    authenticated: "FLOE_RATE_LIMIT_FILE_META_AUTH",
  },
  file_stream_read: {
    public: "FLOE_RATE_LIMIT_FILE_STREAM_PUBLIC",
    authenticated: "FLOE_RATE_LIMIT_FILE_STREAM_AUTH",
  },
} as const;

export type RateLimitScope = keyof typeof LIMIT_DEFAULTS;
export type RateLimitTier = keyof (typeof LIMIT_DEFAULTS)["upload_control"];

function buildLimits() {
  const limits = {} as Record<RateLimitScope, Record<RateLimitTier, number>>;

  for (const scope of Object.keys(LIMIT_DEFAULTS) as RateLimitScope[]) {
    limits[scope] = {
      public: parsePositiveIntEnv(
        LIMIT_ENV[scope].public,
        LIMIT_DEFAULTS[scope].public
      ),
      authenticated: parsePositiveIntEnv(
        LIMIT_ENV[scope].authenticated,
        LIMIT_DEFAULTS[scope].authenticated
      ),
    };
  }

  return limits;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  throw new Error(`${name} must be one of: 1, 0, true, false`);
}

function assertTierOrder(limits: Record<RateLimitScope, Record<RateLimitTier, number>>) {
  for (const scope of Object.keys(limits) as RateLimitScope[]) {
    const pub = limits[scope].public;
    const auth = limits[scope].authenticated;
    if (auth < pub) {
      throw new Error(
        `Invalid rate limit config for ${scope}: authenticated (${auth}) must be >= public (${pub})`
      );
    }
  }
}

const builtLimits = buildLimits();
assertTierOrder(builtLimits);

const maxFileSizeBytes = {
  public: parsePositiveIntEnv(
    "FLOE_PUBLIC_MAX_FILE_SIZE_BYTES",
    100 * 1024 * 1024
  ),
  authenticated: parsePositiveIntEnv(
    "FLOE_AUTH_MAX_FILE_SIZE_BYTES",
    15 * 1024 * 1024 * 1024
  ),
} as const;

if (maxFileSizeBytes.authenticated < maxFileSizeBytes.public) {
  throw new Error(
    `Invalid upload policy: FLOE_AUTH_MAX_FILE_SIZE_BYTES (${maxFileSizeBytes.authenticated}) must be >= FLOE_PUBLIC_MAX_FILE_SIZE_BYTES (${maxFileSizeBytes.public})`
  );
}

export const AuthRateLimitConfig = {
  windowSeconds: parsePositiveIntEnv("FLOE_RATE_LIMIT_WINDOW_SECONDS", 60),
  limits: builtLimits,
} as const;

export const AuthUploadPolicyConfig = {
  maxFileSizeBytes,
} as const;

export const AuthOwnerPolicyConfig = {
  enforceUploadOwner: parseBoolEnv("FLOE_ENFORCE_UPLOAD_OWNER", false),
} as const;
