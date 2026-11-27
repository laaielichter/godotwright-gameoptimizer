// Every fix goes through a transaction: the files it changes are backed up under .gameoptimizer/journal/, so one
// call undoes it. Dry runs go through the same code and write nothing.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";

const DIR = ".gameoptimizer";

export class Transaction {
  constructor(project, fix, { dryRun = false } = {}) {
    this.project = project;
    this.fix = fix;
    this.dryRun = dryRun;
    this.writes = new Map(); // res path → content (string or Buffer)
    this.deletes = new Set();
    this.notes = [];
  }
  write(resPath, content) {
    this.writes.set(this.project.rel(resPath), content);
  }
  delete(resPath) {
    this.deletes.add(this.project.rel(resPath));
  }
  get size() {
    return this.writes.size + this.deletes.size;
  }
  commit(summary = {}) {
    const changed = [];
    const created = [];
    for (const p of this.writes.keys()) (this.project.exists(p) ? changed : created).push(p);
    const result = { fix: this.fix, dry_run: this.dryRun, changed, created, deleted: [...this.deletes].filter((p) => this.project.exists(p)), ...summary };
    if (this.dryRun || this.size === 0) return result;
    const root = join(this.project.root, DIR);
    mkdirSync(join(root, "journal"), { recursive: true });
    if (!existsSync(join(root, ".gdignore"))) writeFileSync(join(root, ".gdignore"), "");
    const ids = readdirSync(join(root, "journal")).map((n) => parseInt(n, 10)).filter(Number.isFinite);
    const id = (ids.length ? Math.max(...ids) : 0) + 1;
    const name = `${String(id).padStart(4, "0")}-${this.fix}`;
    const dir = join(root, "journal", name);
    mkdirSync(join(dir, "files"), { recursive: true });
    const backup = (p) => {
      const dst = join(dir, "files", p);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(this.project.abs(p), dst);
    };
    for (const p of [...changed, ...result.deleted]) backup(p);
    writeFileSync(join(dir, "entry.json"), JSON.stringify({ id, fix: this.fix, time: new Date().toISOString(), changed, created, deleted: result.deleted, summary }, null, 1));
    for (const [p, content] of this.writes) {
      const abs = this.project.abs(p);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      this.project.invalidate(p);
    }
    for (const p of result.deleted) unlinkSync(this.project.abs(p));
    result.journal = id;
    result.undo = `gameoptimizer undo ${id}`;
    return result;
  }
}

export function journalEntries(project) {
  const dir = join(project.root, DIR, "journal");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((n) => {
      try {
        return { dir: join(dir, n), ...JSON.parse(readFileSync(join(dir, n, "entry.json"), "utf8")) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Undoes one journal entry (the last one by default). Later entries that touched the same files are refused. */
export function undo(project, id) {
  const entries = journalEntries(project).filter((e) => !e.undone);
  if (entries.length === 0) return { undone: null, message: "Nothing to undo." };
  const entry = id === undefined ? entries[entries.length - 1] : entries.find((e) => e.id === Number(id));
  if (!entry) return { undone: null, message: `No journal entry ${id}. Entries: ${entries.map((e) => `${e.id} (${e.fix})`).join(", ")}` };
  const touched = new Set([...entry.changed, ...entry.created, ...entry.deleted]);
  const later = entries.filter((e) => e.id > entry.id && [...e.changed, ...e.created, ...e.deleted].some((p) => touched.has(p)));
  if (later.length) return { undone: null, message: `Entries ${later.map((e) => `${e.id} (${e.fix})`).join(", ")} changed the same files after entry ${entry.id}. Undo those first.` };
  for (const p of [...entry.changed, ...entry.deleted]) {
    const abs = project.abs(p);
    mkdirSync(dirname(abs), { recursive: true });
    copyFileSync(join(entry.dir, "files", p), abs);
  }
  for (const p of entry.created) {
    try {
      unlinkSync(project.abs(p));
    } catch {
      /* already gone */
    }
  }
  rmSync(entry.dir, { recursive: true, force: true });
  return { undone: entry.id, fix: entry.fix, restored: [...entry.changed, ...entry.deleted], removed: entry.created };
}
