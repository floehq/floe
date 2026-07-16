import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json");

export const FLOE_API_VERSION = "v1";
export const FLOE_SERVER_VERSION: string = pkg.version;
export const FLOE_SERVICE_NAME = `floe-api-${FLOE_API_VERSION}`;

export const FLOE_CLIENT_COMPATIBILITY = {
  sdk: ">=0.2.0 <0.3.0",
  cli: ">=0.2.0 <0.3.0",
} as const;

export function buildVersionInfo() {
  return {
    service: FLOE_SERVICE_NAME,
    apiVersion: FLOE_API_VERSION,
    serverVersion: FLOE_SERVER_VERSION,
    compatibility: FLOE_CLIENT_COMPATIBILITY,
  };
}
