import { getPostgres } from "../state/postgres.js";

export type IndexedFileRecord = {
  fileId: string;
  blobId: string;
  blobObjectId: string | null;
  checksum: string | null;
  ownerAddress: string | null;
  sizeBytes: number;
  mimeType: string;
  walrusEndEpoch: number | null;
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
      checksum text null,
      owner_address text null,
      size_bytes bigint not null,
      mime_type text not null,
      walrus_end_epoch bigint null,
      created_at_ms bigint not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await pg.query(`
    create index if not exists floe_files_owner_created_idx
    on floe_files (owner_address, created_at desc);
  `);

  await pg.query(`
    create index if not exists floe_files_checksum_idx
    on floe_files (checksum, updated_at desc);
  `);

  // Migration for existing table
  await pg
    .query(
      `
    alter table floe_files add column if not exists blob_object_id text;
  `,
    )
    .catch(() => {});
  await pg
    .query(
      `
    alter table floe_files add column if not exists checksum text;
  `,
    )
    .catch(() => {});

  await pg.query(`
    create table if not exists floe_blob_objects (
      blob_id text primary key,
      blob_object_id text not null,
      checksum text null,
      updated_at timestamptz not null default now()
    );
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
        file_id, blob_id, blob_object_id, checksum, owner_address, size_bytes, mime_type, walrus_end_epoch, created_at_ms, updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
      on conflict (file_id) do update set
        blob_id = excluded.blob_id,
        blob_object_id = excluded.blob_object_id,
        checksum = excluded.checksum,
        owner_address = excluded.owner_address,
        size_bytes = excluded.size_bytes,
        mime_type = excluded.mime_type,
        walrus_end_epoch = excluded.walrus_end_epoch,
        created_at_ms = excluded.created_at_ms,
        updated_at = now()
    `,
    [
      record.fileId,
      record.blobId,
      record.blobObjectId,
      record.checksum,
      record.ownerAddress,
      Math.trunc(record.sizeBytes),
      record.mimeType,
      record.walrusEndEpoch,
      Math.trunc(record.createdAtMs),
    ],
  );

  if (record.blobObjectId) {
    await upsertBlobObjectMapping({
      blobId: record.blobId,
      blobObjectId: record.blobObjectId,
      checksum: record.checksum,
    }).catch(() => {});
  }
}

export async function getIndexedFile(fileId: string): Promise<IndexedFileRecord | null> {
  const pg = getPostgres();
  if (!pg) return null;

  const out = await pg.query(
    `
      select
        f.file_id,
        f.blob_id,
        coalesce(f.blob_object_id, m.blob_object_id) as blob_object_id,
        f.checksum,
        f.owner_address,
        f.size_bytes,
        f.mime_type,
        f.walrus_end_epoch,
        f.created_at_ms
      from floe_files f
      left join floe_blob_objects m on m.blob_id = f.blob_id
      where f.file_id = $1
      limit 1
    `,
    [fileId],
  );

  const row = out.rows[0];
  if (!row) return null;

  return {
    fileId: String(row.file_id),
    blobId: String(row.blob_id),
    blobObjectId: row.blob_object_id ? String(row.blob_object_id) : null,
    checksum: row.checksum ? String(row.checksum) : null,
    ownerAddress: row.owner_address ? String(row.owner_address) : null,
    sizeBytes: Number(row.size_bytes),
    mimeType: String(row.mime_type),
    walrusEndEpoch:
      row.walrus_end_epoch === null || row.walrus_end_epoch === undefined
        ? null
        : Number(row.walrus_end_epoch),
    createdAtMs: Number(row.created_at_ms),
  };
}

export async function findFileByChecksum(checksum: string): Promise<IndexedFileRecord | null> {
  const pg = getPostgres();
  if (!pg) return null;

  const out = await pg.query(
    `
      select
        f.file_id,
        f.blob_id,
        coalesce(f.blob_object_id, m.blob_object_id) as blob_object_id,
        f.checksum,
        f.owner_address,
        f.size_bytes,
        f.mime_type,
        f.walrus_end_epoch,
        f.created_at_ms
      from floe_files f
      left join floe_blob_objects m on m.blob_id = f.blob_id
      where f.checksum = $1
      order by f.walrus_end_epoch desc nulls last, f.updated_at desc, f.created_at_ms desc
      limit 1
    `,
    [checksum],
  );

  const row = out.rows[0];
  if (!row) return null;

  return {
    fileId: String(row.file_id),
    blobId: String(row.blob_id),
    blobObjectId: row.blob_object_id ? String(row.blob_object_id) : null,
    checksum: row.checksum ? String(row.checksum) : null,
    ownerAddress: row.owner_address ? String(row.owner_address) : null,
    sizeBytes: Number(row.size_bytes),
    mimeType: String(row.mime_type),
    walrusEndEpoch:
      row.walrus_end_epoch === null || row.walrus_end_epoch === undefined
        ? null
        : Number(row.walrus_end_epoch),
    createdAtMs: Number(row.created_at_ms),
  };
}

export async function findFileByBlobId(blobId: string): Promise<IndexedFileRecord | null> {
  const pg = getPostgres();
  if (!pg) return null;

  const out = await pg.query(
    `
      select
        f.file_id,
        f.blob_id,
        coalesce(f.blob_object_id, m.blob_object_id) as blob_object_id,
        f.checksum,
        f.owner_address,
        f.size_bytes,
        f.mime_type,
        f.walrus_end_epoch,
        f.created_at_ms
      from floe_files f
      left join floe_blob_objects m on m.blob_id = f.blob_id
      where f.blob_id = $1
      order by f.walrus_end_epoch desc nulls last, f.updated_at desc, f.created_at_ms desc
      limit 1
    `,
    [blobId],
  );

  const row = out.rows[0];
  if (!row) return null;

  return {
    fileId: String(row.file_id),
    blobId: String(row.blob_id),
    blobObjectId: row.blob_object_id ? String(row.blob_object_id) : null,
    checksum: row.checksum ? String(row.checksum) : null,
    ownerAddress: row.owner_address ? String(row.owner_address) : null,
    sizeBytes: Number(row.size_bytes),
    mimeType: String(row.mime_type),
    walrusEndEpoch:
      row.walrus_end_epoch === null || row.walrus_end_epoch === undefined
        ? null
        : Number(row.walrus_end_epoch),
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
    [record.blobId, record.blobObjectId, record.checksum ?? null],
  );
}

export async function getBlobObjectIdByBlobId(blobId: string): Promise<string | null> {
  const pg = getPostgres();
  if (!pg) return null;

  const out = await pg.query(
    `
      select blob_object_id
      from floe_blob_objects
      where blob_id = $1
      limit 1
    `,
    [blobId],
  );
  const row = out.rows[0];
  if (!row?.blob_object_id) return null;
  return String(row.blob_object_id);
}
