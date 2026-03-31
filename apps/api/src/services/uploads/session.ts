import fs from "fs";
import path from "path";

import { UploadConfig } from "../../config/uploads.config.js";
import { UploadSession } from "../../types/upload.js";
import { getRedis } from "../../state/redis.js";
import { uploadKeys } from "../../state/keys.js";
import { chunkStore } from "../../store/index.js";


export type InternalSession = UploadSession;


function ensureFsFolder(uploadId: string) {
  const dir = path.join(UploadConfig.tmpDir, uploadId);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err: any) {
    if (err.code !== "EEXIST") {
      throw err;
    }
  }
}

function sessionTtlSeconds() {
  return Math.max(1, Math.ceil(UploadConfig.sessionTtlMs / 1000));
}

function metaTtlSeconds() {
  return Math.max(1, Math.ceil((UploadConfig.sessionTtlMs + 30 * 60 * 1000) / 1000));
}


export async function createSession(input: {
  uploadId: string;
  filename: string;
  contentType: string;
  owner?: string;
  sizeBytes: number;
  chunkSize: number;
  totalChunks: number;
  epochs: number;
}): Promise<InternalSession> {
  const redis = getRedis();
  const now = Date.now();

  const {
    uploadId,
    filename,
    contentType,
    owner,
    sizeBytes,
    chunkSize,
    totalChunks,
    epochs,
  } = input;

  if (!uploadId) throw new Error("UPLOAD_ID_REQUIRED");
  if (!Number.isInteger(epochs) || epochs <= 0) {
    throw new Error("INVALID_EPOCHS");
  }

  const expiresAt = now + UploadConfig.sessionTtlMs;
  const sessionTtlSecondsValue = sessionTtlSeconds();
  const metaTtlSecondsValue = metaTtlSeconds();

  const tx = redis.multi()
    .hset(uploadKeys.session(uploadId), {
      uploadId,
      filename,
      contentType,
      ...(owner ? { owner } : {}),
      sizeBytes: String(sizeBytes),
      chunkSize: String(chunkSize),
      totalChunks: String(totalChunks),
      epochs: String(epochs),
      status: "uploading",
      createdAt: String(now),
      updatedAt: String(now),
      expiresAt: String(expiresAt),
    })
    .expire(uploadKeys.session(uploadId), sessionTtlSecondsValue)

    .hset(uploadKeys.meta(uploadId), {
      status: "uploading",
      createdAt: String(now),
      updatedAt: String(now),
      expiresAt: String(expiresAt),
      ...(owner ? { owner } : {}),
      sizeBytes: String(sizeBytes),
      chunkSize: String(chunkSize),
      totalChunks: String(totalChunks),
    })
    .expire(uploadKeys.meta(uploadId), metaTtlSecondsValue)

    .sadd(uploadKeys.gcIndex(), uploadId)
    .sadd(uploadKeys.activeIndex(), uploadId);

  const results = await tx.exec();
  if (!results) {
    throw new Error("REDIS_TRANSACTION_FAILED");
  }

  try {
    if (chunkStore.backend() === "disk") {
      ensureFsFolder(uploadId);
    }
  } catch (err) {
    // Redis state may already exist; roll back so we don't leave orphan sessions.
    await redis
      .multi()
      .del(uploadKeys.session(uploadId))
      .del(uploadKeys.meta(uploadId))
      .del(uploadKeys.chunks(uploadId))
      .srem(uploadKeys.gcIndex(), uploadId)
      .srem(uploadKeys.activeIndex(), uploadId)
      .exec()
      .catch(() => {});
    throw err;
  }

  return {
    uploadId,
    filename,
    contentType,
    owner,
    sizeBytes,
    chunkSize,
    totalChunks,
    receivedChunks: [],
    resolvedEpochs: epochs,
    status: "uploading",
    createdAt: now,
    expiresAt,
  };
}

export async function touchUploadActivity(params: {
  uploadId: string;
  chunkIndex?: number;
}): Promise<boolean> {
  const redis = getRedis();
  const now = Date.now();
  const expiresAt = now + UploadConfig.sessionTtlMs;
  const sessionKey = uploadKeys.session(params.uploadId);
  const metaKey = uploadKeys.meta(params.uploadId);
  const fields = {
    updatedAt: String(now),
    expiresAt: String(expiresAt),
    ...(params.chunkIndex !== undefined
      ? {
          lastChunkIndex: String(params.chunkIndex),
          lastChunkAt: String(now),
        }
      : {}),
  };
  const script = `
    local sessionKey = KEYS[1]
    local metaKey = KEYS[2]
    local gcKey = KEYS[3]
    local activeKey = KEYS[4]
    local uploadId = ARGV[1]
    local sessionTtl = tonumber(ARGV[2])
    local metaTtl = tonumber(ARGV[3])
    if redis.call("EXISTS", sessionKey) == 0 then
      return 0
    end

    local status = redis.call("HGET", metaKey, "status")
    if status ~= false and status ~= "uploading" then
      return 0
    end

    redis.call("HSET", sessionKey, unpack(ARGV, 4))
    redis.call("EXPIRE", sessionKey, sessionTtl)
    redis.call("HSET", metaKey, unpack(ARGV, 4))
    redis.call("EXPIRE", metaKey, metaTtl)
    redis.call("SADD", gcKey, uploadId)
    redis.call("SADD", activeKey, uploadId)
    return 1
  `;
  const kvArgs = Object.entries(fields).flatMap(([field, value]) => [field, value]);
  const result = await redis.eval(
    script,
    [sessionKey, metaKey, uploadKeys.gcIndex(), uploadKeys.activeIndex()],
    [
      params.uploadId,
      String(sessionTtlSeconds()),
      String(metaTtlSeconds()),
      ...kvArgs,
    ]
  );
  return Number(result) === 1;
}


export async function getSession(
  uploadId: string
): Promise<InternalSession | null> {
  const redis = getRedis();

  const data = await redis.hgetall<Record<string, string>>(
    uploadKeys.session(uploadId)
  );

  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  const sizeBytes = Number(data.sizeBytes);
  const chunkSize = Number(data.chunkSize);
  const totalChunks = Number(data.totalChunks);
  const epochs = Number(data.epochs);
  const createdAt = Number(data.createdAt);
  const expiresAt = Number(data.expiresAt);

  if (
    !Number.isFinite(sizeBytes) ||
    !Number.isFinite(chunkSize) ||
    !Number.isInteger(totalChunks) ||
    !Number.isInteger(epochs) ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt)
  ) {
    throw new Error("CORRUPT_UPLOAD_SESSION");
  }

  return {
    uploadId,
    filename: data.filename,
    contentType: data.contentType,
    owner: data.owner,
    sizeBytes,
    chunkSize,
    totalChunks,
    receivedChunks: [],
    resolvedEpochs: epochs,
    status: data.status as any,
    createdAt,
    expiresAt,
  };
}
