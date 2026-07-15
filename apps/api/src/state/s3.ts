import { parseBoolEnv } from "../utils/parseEnv.js";
import { createRequire } from "module";
import type { FastifyBaseLogger } from "fastify";

const require = createRequire(import.meta.url);

type AwsS3Module = {
  S3Client: new (...args: any[]) => any;
  HeadBucketCommand: new (...args: any[]) => any;
  CreateBucketCommand: new (...args: any[]) => any;
};

function loadAwsS3(): AwsS3Module {
  try {
    return require("@aws-sdk/client-s3") as AwsS3Module;
  } catch {
    throw new Error(
      "S3 chunk store requires @aws-sdk/client-s3. Install it with: npm install --workspace=apps/api @aws-sdk/client-s3",
    );
  }
}

function buildS3Client() {
  const aws = loadAwsS3();
  const region = (process.env.FLOE_S3_REGION ?? "us-east-1").trim();
  const endpoint = (process.env.FLOE_S3_ENDPOINT ?? "").trim();
  const forcePathStyle = parseBoolEnv("FLOE_S3_FORCE_PATH_STYLE", true);
  const accessKeyId = (process.env.FLOE_S3_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = (process.env.FLOE_S3_SECRET_ACCESS_KEY ?? "").trim();
  const sessionToken = (process.env.FLOE_S3_SESSION_TOKEN ?? "").trim();

  const client = new aws.S3Client({
    region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle,
    ...(accessKeyId && secretAccessKey
      ? {
          credentials: {
            accessKeyId,
            secretAccessKey,
            ...(sessionToken ? { sessionToken } : {}),
          },
        }
      : {}),
  });

  return {
    client,
    HeadBucketCommand: aws.HeadBucketCommand,
    CreateBucketCommand: aws.CreateBucketCommand,
  };
}

export type S3DependencyHealth = {
  configured: boolean;
  ok: boolean | null;
  latencyMs: number | null;
  status: "healthy" | "unavailable" | "disabled";
};

/**
 * Lightweight S3 liveness check — issues a HeadBucket request and
 * returns whether the bucket is reachable.
 */
export async function checkS3Health(): Promise<S3DependencyHealth> {
  const mode = (process.env.FLOE_CHUNK_STORE_MODE ?? "s3").trim().toLowerCase();
  if (mode !== "s3") {
    return {
      configured: false,
      ok: null,
      latencyMs: null,
      status: "disabled",
    };
  }

  const bucket = (process.env.FLOE_S3_BUCKET ?? "").trim();
  if (!bucket) {
    return {
      configured: false,
      ok: null,
      latencyMs: null,
      status: "disabled",
    };
  }

  const start = Date.now();
  try {
    const { client, HeadBucketCommand } = buildS3Client();
    await client.send(
      new HeadBucketCommand({
        Bucket: bucket,
      }),
    );
    return {
      configured: true,
      ok: true,
      latencyMs: Date.now() - start,
      status: "healthy",
    };
  } catch {
    return {
      configured: true,
      ok: false,
      latencyMs: Date.now() - start,
      status: "unavailable",
    };
  }
}

export function isS3BucketMissingError(err: unknown): boolean {
  const candidate = err as {
    name?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const statusCode = Number(candidate?.$metadata?.httpStatusCode ?? 0);
  if (statusCode === 404) return true;

  const errorCode = String(candidate?.Code ?? candidate?.code ?? candidate?.name ?? "").trim();
  return (
    errorCode === "NotFound" || errorCode === "NoSuchBucket" || errorCode === "NoSuchContainer"
  );
}

export async function initS3IfEnabled(log: FastifyBaseLogger): Promise<void> {
  const mode = (process.env.FLOE_CHUNK_STORE_MODE ?? "s3").trim().toLowerCase();
  if (mode !== "s3") return;

  const bucket = (process.env.FLOE_S3_BUCKET ?? "").trim();
  if (!bucket) {
    throw new Error("Missing required env: FLOE_S3_BUCKET");
  }

  const createIfMissing = parseBoolEnv("FLOE_S3_CREATE_BUCKET_IF_MISSING", false);
  const { client, HeadBucketCommand, CreateBucketCommand } = buildS3Client();

  try {
    await client.send(
      new HeadBucketCommand({
        Bucket: bucket,
      }),
    );
    log.info({ bucket }, "S3 chunk store bucket verified");
    return;
  } catch (err) {
    if (!createIfMissing || !isS3BucketMissingError(err)) throw err;
  }

  await client.send(
    new CreateBucketCommand({
      Bucket: bucket,
    }),
  );
  log.info({ bucket }, "S3 chunk store bucket created");
}
