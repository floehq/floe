import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WALRUS_CLI_BIN = (process.env.FLOE_WALRUS_CLI_BIN ?? "walrus").trim();
const WALRUS_CLI_WALLET = process.env.FLOE_WALRUS_CLI_WALLET?.trim() || undefined;
const WALRUS_CLI_CONTEXT = process.env.FLOE_WALRUS_CLI_CONTEXT?.trim() || undefined;

function defaultWalrusCliConfigPath(): string | undefined {
  const configured = process.env.FLOE_WALRUS_CLI_CONFIG?.trim();
  if (configured) return configured;

  if (process.env.FLOE_NETWORK === "testnet") {
    return path.join(os.homedir(), ".walrus", "client_config.yaml");
  }

  return undefined;
}

export async function getCurrentWalrusEpoch(): Promise<number | null> {
  const args = ["info", "epoch", "--json"];
  const walrusConfig = defaultWalrusCliConfigPath();
  if (walrusConfig) args.push("--config", walrusConfig);
  if (WALRUS_CLI_CONTEXT) args.push("--context", WALRUS_CLI_CONTEXT);
  if (WALRUS_CLI_WALLET) args.push("--wallet", WALRUS_CLI_WALLET);

  try {
    const { stdout } = await execFileAsync(WALRUS_CLI_BIN, args, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const match = String(stdout).match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { currentEpoch?: number };
    return Number.isFinite(parsed.currentEpoch) ? Number(parsed.currentEpoch) : null;
  } catch {
    return null;
  }
}
