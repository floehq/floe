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

export const AuthRateLimitConfig = {
  windowSeconds: parsePositiveIntEnv("FLOE_RATE_LIMIT_WINDOW_SECONDS", 60),
  limits: buildLimits(),
} as const;

export const AuthUploadPolicyConfig = {
  maxFileSizeBytes: {
    public: parsePositiveIntEnv(
      "FLOE_PUBLIC_MAX_FILE_SIZE_BYTES",
      100 * 1024 * 1024
    ),
    authenticated: parsePositiveIntEnv(
      "FLOE_AUTH_MAX_FILE_SIZE_BYTES",
      15 * 1024 * 1024 * 1024
    ),
  },
} as const;
