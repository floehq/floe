import os from "node:os";
import { TopologyConfig } from "../../config/topology.config.js";
import { FLOE_SERVER_VERSION } from "../../version.js";

let _instanceId: string | null = null;

/**
 * Resolve the stable instance identifier for this process.
 *
 * Priority:
 *   1. FLOE_INSTANCE_ID env var (explicit override for orchestrators)
 *   2. hostname:PORT (auto-detected from the running environment)
 */
export function getInstanceId(): string {
  if (_instanceId) return _instanceId;

  const explicit = process.env.FLOE_INSTANCE_ID?.trim();
  if (explicit) {
    _instanceId = explicit;
  } else {
    const hostname = os.hostname();
    const port = process.env.PORT?.trim() ?? "3000";
    _instanceId = `${hostname}:${port}`;
  }

  return _instanceId;
}

/** Labels to attach to every metric line for multi-instance distinction. */
export function getInstanceLabels(): { instance: string } {
  return { instance: getInstanceId() };
}

/** Labels for the floe_instance_info info gauge. */
export function getInstanceInfoLabels(): {
  instance: string;
  role: string;
  version: string;
  hostname: string;
} {
  return {
    instance: getInstanceId(),
    role: TopologyConfig.role,
    version: FLOE_SERVER_VERSION,
    hostname: os.hostname(),
  };
}

/** Reset cached instance ID (test-only). */
export function resetInstanceIdForTests(): void {
  _instanceId = null;
}
