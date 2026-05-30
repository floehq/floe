import { getPostgres } from "../state/postgres.js";

export type IndexedFileRecord = {
  fileId: string;
  blobId: string;
  blobObjectId: string | null;
  filename: string | null;
  checksum: string | null;
  ownerAddress: string | null;
  sizeBytes: number;
  mimeType: string;
  walrusEndEpoch: number | null;
  targetChain: string | null;
  anchorTxId: string | null;
  createdAtMs: number;
};

export async function ensureFilesTable(): Promise<void> {
  const pg = getPostgres();
  if (!pg) return;

  await pg.query(`
    create table if not exists floe_files (
      file_id text primary key,
      blob_id text not null,
      blob_object_id text null,
      filename text null,
      checksum text null,
      owner_address text null,
      size_bytes bigint not null,
      mime_type text not null,
      walrus_end_epoch bigint null,
      target_chain text null,
      anchor_tx_id text null,
      created_at_ms bigint not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await pg.query(`
    create table if not exists floe_blob_objects (
      blob_id text primary key,
      blob_object_id text not null,
      checksum text null,
      updated_at timestamptz not null default now()
    );
  `);

  // Migration for existing table
  await Promise.all([
    pg.query(`alter table floe_files add column if not exists blob_object_id text;`).catch(() => {}),
    pg.query(`alter table floe_files add column if not exists filename text;`).catch(() => {}),
    pg.query(`alter table floe_files add column if not exists checksum text;`).catch(() => {}),
    pg.query(`alter table floe_files add column if not exists walrus_end_epoch bigint;`).catch(() => {}),
    pg.query(`alter table floe_files add column if not exists target_chain text;`).catch(() => {}),
    pg.query(`alter table floe_files add column if not exists anchor_tx_id text;`).catch(() => {}),
  ]);

  await pg.query(`
    create index if not exists floe_files_owner_created_idx
    on floe_files (owner_address, created_at desc);
  `);

  await pg.query(`
    create index if not exists floe_files_checksum_idx
    on floe_files (checksum, updated_at desc);
  `);

  await pg.query(`
    create index if not exists floe_blob_objects_checksum_idx
    on floe_blob_objects (checksum, updated_at desc);
  `);
}

export async function upsertIndexedFile(record: IndexedFileRecord): Promise<void> {
  const pg = getPostgres();
  if (!pg) return;

  await pg.query(
    `
      insert into floe_files (
        file_id, blob_id, blob_object_id, filename, checksum, owner_address, size_bytes, mime_type, walrus_end_epoch, target_chain, anchor_tx_id, created_at_ms, updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
      on conflict (file_id) do update set
        blob_id = excluded.blob_id,
        blob_object_id = excluded.blob_object_id,
        filename = excluded.filename,
        checksum = excluded.checksum,
        owner_address = excluded.owner_address,
        size_bytes = excluded.size_bytes,
        mime_type = excluded.mime_type,
        walrus_end_epoch = excluded.walrus_end_epoch,
        target_chain = excluded.target_chain,
        anchor_tx_id = excluded.anchor_tx_id,
        created_at_ms = excluded.created_at_ms,
        updated_at = now()
    `,
    [
      record.fileId,
      record.blobId,
      record.blobObjectId,
      record.filename,
      record.checksum,
      record.ownerAddress,
      Math.trunc(record.sizeBytes),
      record.mimeType,
      record.walrusEndEpoch,
      record.targetChain,
      record.anchorTxId,
      Math.trunc(record.createdAtMs),
    ]
  );

  if (record.blobObjectId) {
    await upsertBlobObjectMapping({
      blobId: record.blobId,
      blobObjectId: record.blobObjectId,
      checksum: record.checksum,
    }).catch(() => {});
  }
}

export async function getIndexedFile(
  fileId: string
): Promise<IndexedFileRecord | null> {
  const pg = getPostgres();
  if (!pg) return null;

  const out = await pg.query(
    `
      select
        file_id,
        blob_id,
        blob_object_id,
        filename,
        checksum,
        owner_address,
        size_bytes,
        mime_type,
        walrus_end_epoch,
        target_chain,
        anchor_tx_id,
        created_at_ms
      from floe_files
      where file_id = $1
      limit 1
    `,
    [fileId]
  );

  const row = out.rows[0];
  if (!row) return null;

  return {
    fileId: String(row.file_id),
    blobId: String(row.blob_id),
    blobObjectId: row.blob_object_id ? String(row.blob_object_id) : null,
    filename: row.filename ? String(row.filename) : null,
    checksum: row.checksum ? String(row.checksum) : null,
    ownerAddress: row.owner_address ? String(row.owner_address) : null,
    sizeBytes: Number(row.size_bytes),
    mimeType: String(row.mime_type),
    walrusEndEpoch:
      row.walrus_end_epoch === null || row.walrus_end_epoch === undefined
        ? null
        : Number(row.walrus_end_epoch),
    targetChain: row.target_chain ? String(row.target_chain) : null,
    anchorTxId: row.anchor_tx_id ? String(row.anchor_tx_id) : null,
    createdAtMs: Number(row.created_at_ms),
  };
}

export type DiscoveryFileRecord = IndexedFileRecord;

function parseDiscoveryCursor(cursor?: string): { createdAtMs: number; fileId: string } | null {
  if (!cursor) return null;
  const [rawCreatedAtMs, ...rest] = cursor.split(":");
  const fileId = rest.join(":").trim();
  const createdAtMs = Number(rawCreatedAtMs);
  if (!Number.isFinite(createdAtMs) || !fileId) return null;
  return { createdAtMs, fileId };
}

export async function listDiscoveryFiles(params?: {
  owner?: string | null;
  chain?: string | null;
  limit?: number;
  cursor?: string | null;
}): Promise<{ data: DiscoveryFileRecord[]; nextCursor: string | null; hasNextPage: boolean }> {
  const pg = getPostgres();
  if (!pg) {
    return { data: [], nextCursor: null, hasNextPage: false };
  }

  const requestedLimit =
    typeof params?.limit === "number" && Number.isFinite(params.limit)
      ? params.limit
      : 24;
  const limit = Math.min(100, Math.max(1, requestedLimit));
  const cursor = parseDiscoveryCursor(params?.cursor ?? undefined);
  const where: string[] = [];
  const values: unknown[] = [];

  if (params?.owner) {
    values.push(params.owner);
    where.push(`owner_address = $${values.length}`);
  }
  if (params?.chain) {
    values.push(params.chain.toLowerCase());
    where.push(`lower(coalesce(target_chain, 'sui')) = $${values.length}`);
  }
  if (cursor) {
    values.push(cursor.createdAtMs);
    values.push(cursor.createdAtMs);
    values.push(cursor.fileId);
    where.push(`(created_at_ms < $${values.length - 2} or (created_at_ms = $${values.length - 1} and file_id < $${values.length}))`);
  }

  values.push(limit + 1);

  const out = await pg.query(
    `
      select
        file_id,
        blob_id,
        blob_object_id,
        filename,
        checksum,
        owner_address,
        size_bytes,
        mime_type,
        walrus_end_epoch,
        target_chain,
        anchor_tx_id,
        created_at_ms
      from floe_files
      ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
      order by created_at_ms desc, file_id desc
      limit $${values.length}
    `,
    values
  );

  const rows = out.rows as Array<Record<string, unknown>>;
  const hasNextPage = rows.length > limit;
  const sliced = rows.slice(0, limit);
  const data = sliced.map((row) => ({
    fileId: String(row.file_id),
    blobId: String(row.blob_id),
    blobObjectId: row.blob_object_id ? String(row.blob_object_id) : null,
    filename: row.filename ? String(row.filename) : null,
    checksum: row.checksum ? String(row.checksum) : null,
    ownerAddress: row.owner_address ? String(row.owner_address) : null,
    sizeBytes: Number(row.size_bytes),
    mimeType: String(row.mime_type),
    walrusEndEpoch:
      row.walrus_end_epoch === null || row.walrus_end_epoch === undefined
        ? null
        : Number(row.walrus_end_epoch),
    targetChain: row.target_chain ? String(row.target_chain) : null,
    anchorTxId: row.anchor_tx_id ? String(row.anchor_tx_id) : null,
    createdAtMs: Number(row.created_at_ms),
  }));

  const nextCursor = hasNextPage
    ? `${sliced[sliced.length - 1].createdAtMs}:${sliced[sliced.length - 1].fileId}`
    : null;

  return { data, nextCursor, hasNextPage };
}

export async function findFileByChecksum(
  checksum: string
): Promise<IndexedFileRecord | null> {
  const pg = getPostgres();
  if (!pg) return null;

  const out = await pg.query(
    `
      select
        file_id,
        blob_id,
        blob_object_id,
        filename,
        checksum,
        owner_address,
        size_bytes,
        mime_type,
        walrus_end_epoch,
        target_chain,
        anchor_tx_id,
        created_at_ms
      from floe_files
      where checksum = $1
      order by walrus_end_epoch desc nulls last, updated_at desc, created_at_ms desc
      limit 1
    `,
    [checksum]
  );

  const row = out.rows[0];
  if (!row) return null;

  return {
    fileId: String(row.file_id),
    blobId: String(row.blob_id),
    blobObjectId: row.blob_object_id ? String(row.blob_object_id) : null,
    filename: row.filename ? String(row.filename) : null,
    checksum: row.checksum ? String(row.checksum) : null,
    ownerAddress: row.owner_address ? String(row.owner_address) : null,
    sizeBytes: Number(row.size_bytes),
    mimeType: String(row.mime_type),
    walrusEndEpoch:
      row.walrus_end_epoch === null || row.walrus_end_epoch === undefined
        ? null
        : Number(row.walrus_end_epoch),
    targetChain: row.target_chain ? String(row.target_chain) : null,
    anchorTxId: row.anchor_tx_id ? String(row.anchor_tx_id) : null,
    createdAtMs: Number(row.created_at_ms),
  };
}

export async function findFileByBlobId(
  blobId: string
): Promise<IndexedFileRecord | null> {
  const pg = getPostgres();
  if (!pg) return null;

  const out = await pg.query(
    `
      select
        file_id,
        blob_id,
        blob_object_id,
        filename,
        checksum,
        owner_address,
        size_bytes,
        mime_type,
        walrus_end_epoch,
        target_chain,
        anchor_tx_id,
        created_at_ms
      from floe_files
      where blob_id = $1
      order by walrus_end_epoch desc nulls last, updated_at desc, created_at_ms desc
      limit 1
    `,
    [blobId]
  );

  const row = out.rows[0];
  if (!row) return null;

  return {
    fileId: String(row.file_id),
    blobId: String(row.blob_id),
    blobObjectId: row.blob_object_id ? String(row.blob_object_id) : null,
    filename: row.filename ? String(row.filename) : null,
    checksum: row.checksum ? String(row.checksum) : null,
    ownerAddress: row.owner_address ? String(row.owner_address) : null,
    sizeBytes: Number(row.size_bytes),
    mimeType: String(row.mime_type),
    walrusEndEpoch:
      row.walrus_end_epoch === null || row.walrus_end_epoch === undefined
        ? null
        : Number(row.walrus_end_epoch),
    targetChain: row.target_chain ? String(row.target_chain) : null,
    anchorTxId: row.anchor_tx_id ? String(row.anchor_tx_id) : null,
    createdAtMs: Number(row.created_at_ms),
  };
}

export async function upsertBlobObjectMapping(record: {
  blobId: string;
  blobObjectId: string;
  checksum?: string | null;
}): Promise<void> {
  const pg = getPostgres();
  if (!pg) return;

  await pg.query(
    `
      insert into floe_blob_objects (
        blob_id, blob_object_id, checksum, updated_at
      ) values ($1, $2, $3, now())
      on conflict (blob_id) do update set
        blob_object_id = excluded.blob_object_id,
        checksum = coalesce(excluded.checksum, floe_blob_objects.checksum),
        updated_at = now()
    `,
    [record.blobId, record.blobObjectId, record.checksum ?? null]
  );
}

export async function getBlobObjectIdByBlobId(
  blobId: string
): Promise<string | null> {
  const pg = getPostgres();
  if (!pg) return null;

  const out = await pg.query(
    `
      select blob_object_id
      from floe_blob_objects
      where blob_id = $1
      limit 1
    `,
    [blobId]
  );
  const row = out.rows[0];
  if (!row?.blob_object_id) return null;
  return String(row.blob_object_id);
}
