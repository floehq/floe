function parseOptionalStringEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

export const ServerConfig = {
  publicBaseUrl: parseOptionalStringEnv("FLOE_PUBLIC_BASE_URL") || "http://localhost:3000",
};
