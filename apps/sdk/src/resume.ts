import type { ResumeStore } from "./types.js";

/**
 * Creates a {@link ResumeStore} backed by the browser's `localStorage`.
 *
 * @remarks
 * Each entry is stored under a configurable key prefix (default:
 * `"floe:sdk:resume:"`) to avoid collisions with other applications.
 * Returns `null` silently when `localStorage` is unavailable (e.g., in
 * private-browsing modes or server-side environments).
 *
 * @param prefix - Key prefix for stored entries.
 * @returns A synchronous resume store.
 *
 * @example
 * ```ts
 * const store = createBrowserLocalStorageResumeStore();
 * await store.set("my-upload-key", "upload-123");
 * const id = await store.get("my-upload-key");
 * ```
 */
export function createBrowserLocalStorageResumeStore(prefix = "floe:sdk:resume:"): ResumeStore {
  return {
    get(key) {
      const storage = getLocalStorageSafe();
      if (!storage) return null;
      return storage.getItem(`${prefix}${key}`);
    },
    set(key, uploadId) {
      const storage = getLocalStorageSafe();
      if (!storage) return;
      storage.setItem(`${prefix}${key}`, uploadId);
    },
    remove(key) {
      const storage = getLocalStorageSafe();
      if (!storage) return;
      storage.removeItem(`${prefix}${key}`);
    },
  };
}

/**
 * Creates a {@link ResumeStore} that persists data to a local JSON file on disk.
 *
 * @remarks
 * Only available in Node.js environments. Dynamically imports `node:fs/promises`,
 * `node:os`, and `node:path` so the module can be loaded in any runtime without
 * errors. The default file path is `~/.floe-sdk/resume-store.json`.
 *
 * @param options - Configuration options.
 * @param options.filePath - Custom path for the resume store JSON file.
 * @returns A promise that resolves to an async resume store.
 *
 * @example
 * ```ts
 * const store = await createNodeFileResumeStore();
 * await store.set("video-upload", "upload-abc");
 * const id = await store.get("video-upload");
 * ```
 */
export async function createNodeFileResumeStore(options?: {
  filePath?: string;
}): Promise<ResumeStore> {
  const dynamicImport = new Function("s", "return import(s)") as <T>(
    specifier: string,
  ) => Promise<T>;
  const fs = await dynamicImport<{
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    readFile(path: string, encoding: string): Promise<string>;
    writeFile(path: string, data: string, encoding: string): Promise<void>;
  }>("node:fs/promises");
  const os = await dynamicImport<{ homedir(): string }>("node:os");
  const path = await dynamicImport<{
    join(...parts: string[]): string;
    dirname(path: string): string;
  }>("node:path");

  const filePath =
    options?.filePath?.trim() || path.join(os.homedir(), ".floe-sdk", "resume-store.json");

  const ensureDir = async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  };

  const readMap = async (): Promise<Record<string, string>> => {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};
      return parsed as Record<string, string>;
    } catch {
      return {};
    }
  };

  const writeMap = async (value: Record<string, string>) => {
    await ensureDir();
    await fs.writeFile(filePath, JSON.stringify(value), "utf8");
  };

  return {
    async get(key) {
      const map = await readMap();
      return map[key] ?? null;
    },
    async set(key, uploadId) {
      const map = await readMap();
      map[key] = uploadId;
      await writeMap(map);
    },
    async remove(key) {
      const map = await readMap();
      if (!(key in map)) return;
      delete map[key];
      await writeMap(map);
    },
  };
}

function getLocalStorageSafe(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
