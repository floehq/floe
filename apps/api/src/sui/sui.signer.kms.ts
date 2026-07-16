import { createHash } from "node:crypto";

import type { SuiClient } from "@mysten/sui/client";
import type { SuiTransactionBlockResponse } from "@mysten/sui/client";
import { toB64 } from "@mysten/sui/utils";
import { KMSClient, SignCommand, GetPublicKeyCommand } from "@aws-sdk/client-kms";

import type { SuiSigner, SuiSignAndExecuteInput } from "./sui.signer.js";

/** Sui Ed25519 signature flag byte. */
const ED25519_FLAG = 0x00;

/**
 * AWS KMS-backed Sui signer.
 *
 * Uses an asymmetric Ed25519 key in AWS KMS for signing transactions and
 * personal messages. The private key never leaves KMS.
 *
 * Required env vars when FLOE_SIGNER_BACKEND=kms:
 *   - FLOE_KMS_KEY_ID  — KMS key ID, alias, or ARN (must be an Ed25519 asymmetric key)
 *   - FLOE_SIGNER_ADDRESS — the Sui address derived from the KMS public key
 *                           (0x-prefixed 64 hex chars)
 *
 * AWS credentials are resolved via the standard AWS SDK chain
 * (env vars, instance profile, etc.).
 */
export class KmsSuiSigner implements SuiSigner {
  readonly address: string;
  readonly #kms: KMSClient;
  readonly #keyId: string;
  readonly #client: SuiClient;

  /** Cached public key (base64-encoded raw 32-byte Ed25519 public key). */
  #publicKeyB64: string | null = null;

  constructor(params: { keyId: string; address: string; client: SuiClient; region?: string }) {
    if (!params.keyId) {
      throw new Error("FLOE_KMS_KEY_ID is required when FLOE_SIGNER_BACKEND=kms");
    }
    if (!params.address || !/^0x[0-9a-fA-F]{64}$/.test(params.address)) {
      throw new Error("FLOE_SIGNER_ADDRESS must be a 0x-prefixed 64 hex character Sui address");
    }
    this.#keyId = params.keyId;
    this.address = params.address;
    this.#client = params.client;
    this.#kms = new KMSClient({ region: params.region });
  }

  /**
   * Derive a Sui address from a raw Ed25519 public key (32 bytes).
   *
   * Sui address = first 32 bytes of SHA3-256(0x00 || publicKey).
   */
  static deriveAddress(publicKeyBytes: Uint8Array): string {
    const flagAndKey = Buffer.concat([Buffer.from([ED25519_FLAG]), Buffer.from(publicKeyBytes)]);
    // Sui uses SHA3-256 (not SHA-256). Node's crypto module supports sha3-256.
    const hash = createHash("sha3-256").update(flagAndKey).digest();
    return "0x" + hash.toString("hex");
  }

  async signAndExecuteTransaction(
    input: SuiSignAndExecuteInput,
  ): Promise<SuiTransactionBlockResponse> {
    const txBytes = await input.transaction.build({ client: this.#client });
    const signature = await this.#signBytes(txBytes);
    const suiSig = this.#buildSuiSignature(signature);

    return this.#client.executeTransactionBlock({
      transactionBlock: txBytes,
      signature: suiSig,
      options: input.options,
    });
  }

  async signPersonalMessage(message: Uint8Array): Promise<{ bytes: string; signature: string }> {
    const signature = await this.#signBytes(message);
    const suiSig = this.#buildSuiSignature(signature);

    return { bytes: toB64(message), signature: suiSig };
  }

  async getBalance(): Promise<bigint> {
    const bal = await this.#client.getBalance({ owner: this.address });
    return BigInt(bal.totalBalance);
  }

  /** Sign raw bytes via AWS KMS Ed25519. */
  async #signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const result = await this.#kms.send(
      new SignCommand({
        KeyId: this.#keyId,
        Message: bytes,
        MessageType: "RAW",
        SigningAlgorithm: "ED25519_SHA_512",
      }),
    );

    if (!result.Signature) {
      throw new Error("KMS Sign returned no signature");
    }

    return new Uint8Array(result.Signature);
  }

  /**
   * Construct a Sui-compatible Ed25519 signature.
   *
   * Format: flag (1 byte) || publicKey (32 bytes) || signature (64 bytes)
   * Result is base64-encoded.
   */
  #buildSuiSignature(signatureBytes: Uint8Array): string {
    const pubKeyBytes = this.#getPublicKeyBytes();
    const suiSig = Buffer.concat([
      Buffer.from([ED25519_FLAG]),
      Buffer.from(pubKeyBytes),
      Buffer.from(signatureBytes),
    ]);
    return toB64(suiSig);
  }

  /**
   * Get the raw Ed25519 public key bytes from KMS (cached after first call).
   */
  #getPublicKeyBytes(): Uint8Array {
    // In practice this will be populated by fetchPublicKey() at construction.
    // This sync accessor is only called after fetchPublicKey() completes.
    if (!this.#publicKeyB64) {
      throw new Error("KMS public key not yet fetched — call fetchPublicKey() first");
    }
    return Buffer.from(this.#publicKeyB64, "base64");
  }

  /**
   * Fetch and cache the public key from KMS. Must be called once after
   * construction and before any signing operations.
   */
  async fetchPublicKey(): Promise<void> {
    const result = await this.#kms.send(new GetPublicKeyCommand({ KeyId: this.#keyId }));

    if (!result.PublicKey) {
      throw new Error("KMS GetPublicKey returned no key");
    }

    this.#publicKeyB64 = Buffer.from(result.PublicKey).toString("base64");
  }
}
