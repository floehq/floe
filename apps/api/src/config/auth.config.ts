function parsePositiveIntEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return n;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  throw new Error(`${name} must be one of: 1, 0, true, false`);
}

const SUI_ADDRESS_RE = /^(0x)?[0-9a-fA-F]{64}$/;

function normalizeOptionalSuiAddress(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  if (!SUI_ADDRESS_RE.test(value)) {
    throw new Error(`Invalid Sui address: ${value}`);
  }
  return `0x${value.replace(/^0x/i, "").toLowerCase()}`;
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
export type AuthMode = "public" | "hybrid" | "private";

export interface StaticApiKeyConfig {
  id: string;
  secret: string;
  owner?: string;
  scopes: string[];
  tier: RateLimitTier;
}

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

function parseAuthMode(): AuthMode {
  const raw = process.env.FLOE_AUTH_MODE?.trim().toLowerCase();
  if (!raw) return "hybrid";
  if (raw === "public" || raw === "hybrid" || raw === "private") {
    return raw;
  }
  throw new Error("FLOE_AUTH_MODE must be one of: public, hybrid, private");
}

function parseApiKeys(): StaticApiKeyConfig[] {
  const raw = process.env.FLOE_API_KEYS_JSON?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`FLOE_API_KEYS_JSON must be valid JSON: ${String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("FLOE_API_KEYS_JSON must be a JSON array");
  }

  const seenIds = new Set<string>();
  const seenSecrets = new Set<string>();

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`FLOE_API_KEYS_JSON[${index}] must be an object`);
    }

    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const secret = typeof candidate.secret === "string" ? candidate.secret.trim() : "";
    const tier = candidate.tier === "public" ? "public" : "authenticated";
    const scopes = Array.isArray(candidate.scopes)
      ? candidate.scopes
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .map((value) => value.trim())
      : ["*"];
    const owner = normalizeOptionalSuiAddress(candidate.owner);

    if (!id) throw new Error(`FLOE_API_KEYS_JSON[${index}].id is required`);
    if (!secret) throw new Error(`FLOE_API_KEYS_JSON[${index}].secret is required`);
    if (seenIds.has(id)) throw new Error(`Duplicate API key id: ${id}`);
    if (seenSecrets.has(secret)) {
      throw new Error(`Duplicate API key secret configured for id: ${id}`);
    }

    seenIds.add(id);
    seenSecrets.add(secret);

    return {
      id,
      secret,
      owner,
      scopes: scopes.length > 0 ? scopes : ["*"],
      tier,
    } satisfies StaticApiKeyConfig;
  });
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

export const AuthModeConfig = {
  mode: parseAuthMode(),
} as const;

export const AuthApiKeyConfig = {
  keys: parseApiKeys(),
} as const;
