import { getPostgres } from "../state/postgres.js";

export type IndexedFileRecord = {
  fileId: string;
  blobId: string;
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
}

export async function upsertIndexedFile(record: IndexedFileRecord): Promise<void> {
  const pg = getPostgres();
  if (!pg) return;

  await pg.query(
    `
      insert into floe_files (
        file_id, blob_id, owner_address, size_bytes, mime_type, walrus_end_epoch, created_at_ms, updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7, now())
      on conflict (file_id) do update set
        blob_id = excluded.blob_id,
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
      record.ownerAddress,
      Math.trunc(record.sizeBytes),
      record.mimeType,
      record.walrusEndEpoch,
      Math.trunc(record.createdAtMs),
    ]
  );
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
        owner_address,
        size_bytes,
        mime_type,
        walrus_end_epoch,
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
