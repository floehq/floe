export type FloeNodeRole = "read" | "write" | "full";

export function parseTopologyNodeRole(raw = process.env.FLOE_NODE_ROLE ?? "full"): FloeNodeRole {
  const value = raw.trim().toLowerCase();
  if (value === "read" || value === "write" || value === "full") {
    return value;
  }
  throw new Error("FLOE_NODE_ROLE must be one of: read, write, full");
}

export function buildTopologyConfig(role: FloeNodeRole) {
  return {
    role,
    routes: {
      uploads: role === "write" || role === "full",
      files: role === "read" || role === "full",
      ops: role === "write" || role === "full",
    },
    workers: {
      finalize: role === "write" || role === "full",
      uploadGc: role === "write" || role === "full",
    },
    features: {
      streamCache: role === "read" || role === "full",
    },
  } as const;
}

const role = parseTopologyNodeRole();

export const TopologyConfig = buildTopologyConfig(role);
