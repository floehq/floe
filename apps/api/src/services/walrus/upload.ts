import { uploadToWalrusViaCli, describeWalrusCliBackend } from "./backends/cli.js";
import {
  uploadToWalrusViaPublisher,
  describeWalrusPublisherBackend,
} from "./backends/publisher.js";
import type { WalrusUploadResult } from "./backends/types.js";

export type WalrusStoreMode = "publisher" | "cli";

export function resolveWalrusStoreMode(): WalrusStoreMode {
  const raw = (process.env.FLOE_WALRUS_STORE_MODE ?? "publisher").trim().toLowerCase();
  if (raw === "publisher" || raw === "cli") return raw;
  if (raw === "sdk") return "publisher";
  throw new Error("INVALID_FLOE_WALRUS_STORE_MODE (expected: publisher|cli; sdk is accepted as a legacy alias)");
}

const WALRUS_STORE_MODE = resolveWalrusStoreMode();

export function describeWalrusWriters() {
  if (WALRUS_STORE_MODE === "cli") {
    return {
      mode: "cli" as const,
      primary: null,
      fallbacks: [],
      count: 0,
      ...describeWalrusCliBackend(),
    };
  }

  return {
    mode: "publisher" as const,
    cliBin: null,
    ...describeWalrusPublisherBackend(),
  };
}

export async function uploadToWalrusOnce(
  streamFactory: () => import("stream").Readable,
  epochs: number
): Promise<WalrusUploadResult> {
  if (!Number.isInteger(epochs) || epochs <= 0) {
    throw new Error("INVALID_EPOCHS");
  }

  if (WALRUS_STORE_MODE === "cli") {
    return uploadToWalrusViaCli({ streamFactory, epochs });
  }

  return uploadToWalrusViaPublisher({ streamFactory, epochs });
}
