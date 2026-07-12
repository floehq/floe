import type { ResumeStore } from "./types.js";

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
