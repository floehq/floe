export type FloeNodeRole = "read" | "write" | "full";

function parseNodeRole(): FloeNodeRole {
  const raw = (process.env.FLOE_NODE_ROLE ?? "full").trim().toLowerCase();
  if (raw === "read" || raw === "write" || raw === "full") {
    return raw;
  }
  throw new Error("FLOE_NODE_ROLE must be one of: read, write, full");
}

const role = parseNodeRole();

export const TopologyConfig = {
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
