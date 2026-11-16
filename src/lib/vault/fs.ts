/**
 * Minimal filesystem surface the sync needs, so the planner can be tested
 * against an in-memory vault. Paths are vault-relative with forward slashes.
 */

export interface Stat {
  size: number;
  mtime: number;
}

export interface VaultFS {
  stat(path: string): Promise<Stat | null>;
  readText(path: string): Promise<string | null>;
  readBytes(path: string): Promise<Uint8Array | null>;
  write(path: string, data: string | Uint8Array | ReadableStream<Uint8Array>): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** file names directly inside dir (no recursion); [] when dir is missing */
  listFiles(dir: string): Promise<string[]>;
  /** subdirectory names directly inside dir; [] when dir is missing */
  listDirs(dir: string): Promise<string[]>;
}

function split(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** File System Access API backend rooted at the vault folder the user picked. */
export class HandleFS implements VaultFS {
  constructor(private root: FileSystemDirectoryHandle) {}

  private async dir(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let d = this.root;
    for (const part of parts) {
      try {
        d = await d.getDirectoryHandle(part, { create });
      } catch (ex) {
        if (!create && ['NotFoundError', 'TypeMismatchError'].includes((ex as DOMException).name)) return null;
        throw ex;
      }
    }
    return d;
  }

  private async file(path: string): Promise<File | null> {
    const parts = split(path);
    const name = parts.pop()!;
    const d = await this.dir(parts, false);
    if (!d) return null;
    try {
      return await (await d.getFileHandle(name)).getFile();
    } catch (ex) {
      if (['NotFoundError', 'TypeMismatchError'].includes((ex as DOMException).name)) return null;
      throw ex;
    }
  }

  async stat(path: string): Promise<Stat | null> {
    const f = await this.file(path);
    return f ? { size: f.size, mtime: f.lastModified } : null;
  }

  async readText(path: string): Promise<string | null> {
    const f = await this.file(path);
    return f ? f.text() : null;
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    const f = await this.file(path);
    return f ? new Uint8Array(await f.arrayBuffer()) : null;
  }

  async write(path: string, data: string | Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    const parts = split(path);
    const name = parts.pop()!;
    const d = (await this.dir(parts, true))!;
    const handle = await d.getFileHandle(name, { create: true });
    // createWritable writes to a swap file and only replaces the target on close.
    const writable = await handle.createWritable();
    try {
      if (data instanceof ReadableStream) {
        await data.pipeTo(writable);
      } else {
        await writable.write(data as FileSystemWriteChunkType);
        await writable.close();
      }
    } catch (ex) {
      await writable.abort().catch(() => {});
      throw ex;
    }
  }

  async copy(from: string, to: string): Promise<void> {
    const f = await this.file(from);
    if (!f) throw new Error(`cannot back up missing file ${from}`);
    await this.write(to, f.stream() as ReadableStream<Uint8Array>);
  }

  async remove(path: string): Promise<void> {
    const parts = split(path);
    const name = parts.pop()!;
    const d = await this.dir(parts, false);
    if (!d) return;
    try {
      await d.removeEntry(name);
    } catch (ex) {
      if ((ex as DOMException).name !== 'NotFoundError') throw ex;
    }
    // Drop directories this left empty (never the vault root).
    for (let i = parts.length; i > 0; i--) {
      const parent = (await this.dir(parts.slice(0, i - 1), false))!;
      try {
        await parent.removeEntry(parts[i - 1]);
      } catch {
        break; // not empty
      }
    }
  }

  private async list(dir: string, kind: 'file' | 'directory'): Promise<string[]> {
    const d = await this.dir(split(dir), false);
    if (!d) return [];
    const names: string[] = [];
    for await (const [name, h] of (d as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (h.kind === kind) names.push(name);
    }
    return names.sort();
  }

  listFiles(dir: string): Promise<string[]> {
    return this.list(dir, 'file');
  }

  listDirs(dir: string): Promise<string[]> {
    return this.list(dir, 'directory');
  }
}

/** In-memory backend for tests. */
export class MemoryFS implements VaultFS {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  private clock = 1000;

  set(path: string, data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.files.set(path, { bytes, mtime: this.clock++ });
  }

  async stat(path: string): Promise<Stat | null> {
    const f = this.files.get(path);
    return f ? { size: f.bytes.length, mtime: f.mtime } : null;
  }

  async readText(path: string): Promise<string | null> {
    const f = this.files.get(path);
    return f ? new TextDecoder().decode(f.bytes) : null;
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    return this.files.get(path)?.bytes ?? null;
  }

  async write(path: string, data: string | Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    if (data instanceof ReadableStream) {
      this.set(path, new Uint8Array(await new Response(data).arrayBuffer()));
    } else this.set(path, data);
  }

  async copy(from: string, to: string): Promise<void> {
    const f = this.files.get(from);
    if (!f) throw new Error(`missing ${from}`);
    this.set(to, f.bytes);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  private children(dir: string): { files: Set<string>; dirs: Set<string> } {
    const prefix = dir ? `${dir.replace(/\/$/, '')}/` : '';
    const files = new Set<string>();
    const dirs = new Set<string>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const i = rest.indexOf('/');
      if (i < 0) files.add(rest);
      else dirs.add(rest.slice(0, i));
    }
    return { files, dirs };
  }

  async listFiles(dir: string): Promise<string[]> {
    return [...this.children(dir).files].sort();
  }

  async listDirs(dir: string): Promise<string[]> {
    return [...this.children(dir).dirs].sort();
  }
}
