import type { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { isSecretPath } from "../actions/registry.js";

/**
 * The file index of every device (Jarvis D2). Each device walks its `actions.roots` (names, sizes,
 * dates; never contents, never secret-looking files) and sends the list to the hub, which keeps
 * one table for all of them. So "where is the thrust test sheet?" is answered across devices, even
 * when the one that has it is asleep. A summary per device also goes into the shared memory.
 */

export interface IndexedFile {
  path: string;
  size: number;
  mtime: number;
}

export interface FileHit extends IndexedFile {
  node: string;
  name: string;
}

export interface IndexedNode {
  node: string;
  files: number;
  roots: string[];
  indexedAt: number;
  truncated: boolean;
}

const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".cache", ".gradle", "build", "dist", ".next", ".expo", "Library", "AppData", "$RECYCLE.BIN", "System Volume Information"]);

/** Walks the roots: at most `limit` files, skipping tool folders, hidden folders and secrets. */
export function scanRoots(roots: string[], limit = 200_000): { files: IndexedFile[]; truncated: boolean } {
  const files: IndexedFile[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number) => {
    if (truncated || depth > 25) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      if (SKIP.has(e) || (e.startsWith(".") && e !== ".github")) continue;
      const p = join(dir, e);
      if (isSecretPath(p)) continue;
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(p, depth + 1);
      else if (s.isFile()) files.push({ path: p, size: s.size, mtime: Math.round(s.mtimeMs) });
    }
  };
  for (const r of roots) walk(r, 0);
  return { files, truncated };
}

export class FileIndex {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_index (
        node TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, ext TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL,
        PRIMARY KEY (node, path)
      );
      CREATE INDEX IF NOT EXISTS file_index_name ON file_index(name);
      CREATE TABLE IF NOT EXISTS file_nodes (node TEXT PRIMARY KEY, files INTEGER NOT NULL, roots TEXT NOT NULL, indexed_at INTEGER NOT NULL, truncated INTEGER NOT NULL DEFAULT 0);
    `);
  }

  /** A device's whole list, replacing what it sent last time. */
  replace(node: string, roots: string[], files: IndexedFile[], truncated = false, now = Date.now()) {
    const ins = this.db.prepare("INSERT OR REPLACE INTO file_index (node, path, name, ext, size, mtime) VALUES (?, ?, ?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM file_index WHERE node = ?").run(node);
      let kept = 0;
      for (const f of files) {
        if (isSecretPath(f.path)) continue;
        kept++;
        const name = basename(f.path);
        ins.run(node, f.path, name.toLowerCase(), extname(name).slice(1).toLowerCase(), f.size, f.mtime);
      }
      this.db.prepare("INSERT OR REPLACE INTO file_nodes (node, files, roots, indexed_at, truncated) VALUES (?, ?, ?, ?, ?)").run(node, kept, JSON.stringify(roots), now, truncated ? 1 : 0);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Every word must be in the file's path; newest first. */
  search(q: string, opts: { node?: string; ext?: string; limit?: number } = {}): FileHit[] {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    const where: string[] = [];
    const args: (string | number)[] = [];
    for (const w of words) {
      where.push("lower(path) LIKE ? ESCAPE '\\'");
      args.push(`%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    }
    if (opts.node) where.push("node = ?"), args.push(opts.node);
    if (opts.ext) where.push("ext = ?"), args.push(opts.ext.replace(/^\./, "").toLowerCase());
    const sql = `SELECT node, path, size, mtime FROM file_index ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY mtime DESC LIMIT ?`;
    args.push(Math.min(200, opts.limit ?? 30));
    return (this.db.prepare(sql).all(...args) as { node: string; path: string; size: number; mtime: number }[]).map((r) => ({ ...r, name: basename(r.path) }));
  }

  nodes(): IndexedNode[] {
    return (this.db.prepare("SELECT * FROM file_nodes ORDER BY node").all() as any[]).map((r) => ({ node: r.node, files: r.files, roots: JSON.parse(r.roots), indexedAt: r.indexed_at, truncated: !!r.truncated }));
  }
}
