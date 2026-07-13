import type { SuiClient } from "@mysten/sui/client";
import type {
  SuiTransactionBlockResponse,
  SuiTransactionBlockResponseOptions,
} from "@mysten/sui/client";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

/**
 * Input for SuiSigner.signAndExecuteTransaction.
 */
export type SuiSignAndExecuteInput = {
  transaction: Transaction;
  options?: SuiTransactionBlockResponseOptions;
};

/**
 * Pluggable Sui signer interface.
 *
 * Current implementations:
 *   - EnvSuiSigner — wraps an Ed25519Keypair derived from SUI_PRIVATE_KEY
 *
 * Future implementations (SaaS layer or KMS integration):
 *   - KMS-backed signer, multi-sig, etc.
 */
export interface SuiSigner {
  /** The signer's on-chain address (0x-prefixed hex). */
  readonly address: string;

  /**
   * Sign and submit a transaction via the configured SuiClient RPC.
   * No internal caching — each call hits the RPC.
   */
  signAndExecuteTransaction(input: SuiSignAndExecuteInput): Promise<SuiTransactionBlockResponse>;

  /**
   * Sign arbitrary bytes (used for Walrus publisher auth headers).
   * Returns a serialized signature string (base64) and the original bytes (base64),
   * matching the return type of the underlying Ed25519Keypair.signPersonalMessage().
   */
  signPersonalMessage(message: Uint8Array): Promise<{ bytes: string; signature: string }>;

  /**
   * Query the signer's current SUI balance in MIST.
   * No internal caching — each call hits the RPC.
   * Callers (publisher.ts, health check) maintain their own throttle/cache.
   */
  getBalance(): Promise<bigint>;
}

/**
 * Environment-variable-backed Sui signer.
 *
 * Wraps an Ed25519Keypair (from SUI_PRIVATE_KEY) and the global SuiClient
 * into the SuiSigner interface. Every method delegates to the underlying
 * keypair or RPC client with zero behavior change.
 */
export class EnvSuiSigner implements SuiSigner {
  readonly address: string;
  readonly #keypair: Ed25519Keypair;
  readonly #client: SuiClient;

  constructor(keypair: Ed25519Keypair, client: SuiClient) {
    this.#keypair = keypair;
    this.#client = client;
    this.address = keypair.getPublicKey().toSuiAddress();
  }

  async signAndExecuteTransaction(
    input: SuiSignAndExecuteInput,
  ): Promise<SuiTransactionBlockResponse> {
    return this.#client.signAndExecuteTransaction({
      transaction: input.transaction,
      signer: this.#keypair,
      options: input.options,
    });
  }

  async signPersonalMessage(message: Uint8Array): Promise<{ bytes: string; signature: string }> {
    return this.#keypair.signPersonalMessage(message);
  }

  async getBalance(): Promise<bigint> {
    const bal = await this.#client.getBalance({ owner: this.address });
    return BigInt(bal.totalBalance);
  }
}
