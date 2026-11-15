// The hub's file library: ordinary folders and G-code files under
// ~/Documents/GCode Controller, so projects can be organised from the
// controller or straight from Finder. A hidden index beside them remembers
// each file's id, source, group and analysis so nothing is re-read needlessly.
// Macros and machine config live in the hub's data directory.

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { dirname, extname, join, parse } from 'node:path';
import { analyzeProgram, DEFAULT_CONFIG, randomId, type LibraryItem, type MachineConfig, type Macro } from '@gcc/shared';
import { sha256 } from '@gcc/shared/node';

export const GCODE_EXTENSIONS = ['.nc', '.gcode', '.ngc', '.tap', '.gc', '.cnc', '.txt', '.g'];

const INDEX_FILE = '.gcode-controller.json';
const DELETED_DIR = '.Deleted';

const DEFAULT_MACROS: Macro[] = [
  { id: 'lift-z', name: 'Lift Z 10 mm', gcode: 'G91 G0 Z10\nG90' },
  { id: 'park', name: 'Park at back corner', gcode: 'G53 G0 Z-2\nG53 G0 X-5 Y-5' },
  { id: 'spindle-off', name: 'Spindle off', gcode: 'M5' },
  { id: 'modal', name: 'Show modal state', gcode: '$G' },
];

export interface AddOptions {
  name: string;
  source?: string;
  group?: string;
  groupIndex?: number;
  /** Folder to save into. Default: the group's name for a group, otherwise the top level. */
  folder?: string;
}

export interface LibraryOptions {
  /** Where macros, config and the pre-folders library live. */
  dataDir: string;
  /** The library folder (default <dataDir>/library; the app uses ~/Documents/GCode Controller). */
  libraryDir?: string;
  /** 'system' moves deleted files to the macOS Trash; 'folder' to a hidden .Deleted folder in the library. */
  trash?: 'system' | 'folder';
}

interface Entry extends LibraryItem {
  mtimeMs: number;
}

export class LibraryStore {
  items: Entry[] = [];
  folders: string[] = [];
  macros: Macro[] = DEFAULT_MACROS;
  config: MachineConfig = DEFAULT_CONFIG;
  readonly root: string;
  /** Called after the library changes on disk (Finder edits included). */
  onChange: () => void = () => undefined;

  private readonly dataDir: string;
  private readonly trashMode: 'system' | 'folder';
  private watcher?: FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private rescanTimer?: NodeJS.Timeout;
  /** Files that aren't G-code, by path and mtime, so they aren't re-read every scan. */
  private ignored = new Map<string, number>();

  constructor(opts: LibraryOptions) {
    this.dataDir = opts.dataDir;
    this.root = opts.libraryDir ?? join(opts.dataDir, 'library');
    this.trashMode = opts.trash ?? 'folder';
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.root, { recursive: true });
    this.macros = this.readData('macros.json', DEFAULT_MACROS);
    const saved = this.readData<Partial<MachineConfig>>('config.json', {});
    this.config = { ...DEFAULT_CONFIG, ...saved, probe: { ...DEFAULT_CONFIG.probe, ...saved.probe } };
    try {
      const index = JSON.parse(readFileSync(join(this.root, INDEX_FILE), 'utf8')) as { items?: Entry[] };
      this.items = (index.items ?? []).map((e) => ({ ...e, folder: e.folder ?? '' }));
    } catch {
      this.items = [];
    }
    this.migrateFlatLibrary();
    this.rescan();
  }

  // ---------------- Watching ----------------

  /** Follow changes made in Finder. */
  watch(): void {
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, file) => {
        if (file && String(file).split(/[\\/]/).some((p) => p.startsWith('.'))) return; // our index, .Deleted
        this.scheduleRescan(300);
      });
    } catch {
      // recursive watch unsupported: the poll below still catches changes
    }
    this.pollTimer = setInterval(() => this.scheduleRescan(0), 15000);
  }

  close(): void {
    this.watcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
  }

  private scheduleRescan(ms: number): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined;
      if (this.rescan()) this.onChange();
    }, ms);
  }

  /**
   * Bring the index in line with the folder. Unchanged files (same size and
   * modification time) are kept as they are; a file that disappeared from one
   * place and appeared in another with the same content keeps its id, so a
   * move or rename in Finder doesn't lose its history. Returns true if anything changed.
   */
  rescan(): boolean {
    const dirs: string[] = [];
    const found: { folder: string; name: string; size: number; mtimeMs: number }[] = [];
    const walk = (abs: string, folder: string) => {
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of entries) {
        if (d.name.startsWith('.')) continue;
        const rel = folder ? `${folder}/${d.name}` : d.name;
        if (d.isDirectory()) {
          dirs.push(rel);
          walk(join(abs, d.name), rel);
        } else if (d.isFile() && GCODE_EXTENSIONS.includes(extname(d.name).toLowerCase())) {
          try {
            const st = statSync(join(abs, d.name));
            found.push({ folder, name: d.name, size: st.size, mtimeMs: st.mtimeMs });
          } catch {
            // vanished mid-scan
          }
        }
      }
    };
    walk(this.root, '');

    const byPath = new Map(this.items.map((e) => [relPath(e), e]));
    const unclaimed = new Map(byPath);
    const next: Entry[] = [];
    const changedFiles: typeof found = [];
    for (const f of found) {
      const rel = f.folder ? `${f.folder}/${f.name}` : f.name;
      const e = byPath.get(rel);
      if (e && e.size === f.size && e.mtimeMs === f.mtimeMs) {
        next.push(e);
        unclaimed.delete(rel);
      } else {
        changedFiles.push(f);
      }
    }
    let later = false;
    for (const f of changedFiles) {
      const rel = f.folder ? `${f.folder}/${f.name}` : f.name;
      if (this.ignored.get(rel) === f.mtimeMs) continue;
      // Still being written (a Finder copy, say): look again shortly.
      if (Date.now() - f.mtimeMs < 1000) {
        later = true;
        const e = byPath.get(rel);
        if (e) {
          next.push(e);
          unclaimed.delete(rel);
        }
        continue;
      }
      let buf: Buffer;
      try {
        buf = readFileSync(join(this.root, rel));
      } catch {
        continue;
      }
      const hash = sha256(buf);
      // Same path with new content, or the same content moved here from elsewhere.
      let base = byPath.get(rel);
      if (base) unclaimed.delete(rel);
      else {
        for (const [p, e] of unclaimed) {
          if (e.sha256 === hash) {
            base = e;
            unclaimed.delete(p);
            break;
          }
        }
      }
      const analysis = this.analyze(buf);
      if (!analysis) {
        this.ignored.set(rel, f.mtimeMs);
        continue;
      }
      next.push({
        ...analysis,
        id: base?.id ?? randomId(12),
        name: f.name,
        folder: f.folder,
        source: base?.source ?? 'Finder',
        addedAt: base?.addedAt ?? Date.now(),
        group: base?.group,
        groupIndex: base?.groupIndex,
        size: buf.length,
        sha256: hash,
        mtimeMs: f.mtimeMs,
      });
    }
    if (later) this.scheduleRescan(1200);

    dirs.sort((a, b) => a.localeCompare(b));
    sortItems(next);
    const changed = JSON.stringify(next) !== JSON.stringify(this.items) || JSON.stringify(dirs) !== JSON.stringify(this.folders);
    this.items = next;
    this.folders = dirs;
    if (changed) this.saveIndex();
    return changed;
  }

  // ---------------- Files ----------------

  add(content: Buffer, opts: AddOptions): LibraryItem {
    if (!content.length) throw new Error('The file is empty');
    if (content.includes(0)) throw new Error("That doesn't look like a G-code text file");
    const analysis = this.analyze(content);
    if (!analysis) throw new Error('The file has no G-code in it');
    const folder = opts.folder !== undefined ? checkFolder(opts.folder, true) : opts.group ? folderName(opts.group) : '';
    const name = withGcodeExtension(sanitizeName(opts.name));
    const hash = sha256(content);
    mkdirSync(join(this.root, folder), { recursive: true });

    const existing = this.items.find((i) => i.folder === folder && i.name === name);
    if (existing && existing.sha256 === hash) {
      // The same file again: just bring it to the top.
      Object.assign(existing, {
        addedAt: Date.now(),
        source: opts.source ?? existing.source,
        group: opts.group ?? existing.group,
        groupIndex: opts.groupIndex ?? existing.groupIndex,
      });
      this.saveIndex();
      this.rescanFolders();
      return existing;
    }
    const abs = join(this.root, folder, name);
    // A new version of a file with the same name (a re-export) replaces it; the old one goes to the Trash.
    if (existsSync(abs)) this.trash(abs);
    writeFileSync(abs, content);
    const entry: Entry = {
      ...analysis,
      id: existing?.id ?? randomId(12),
      name,
      folder,
      source: opts.source || 'Upload',
      size: content.length,
      sha256: hash,
      addedAt: Date.now(),
      mtimeMs: statSync(abs).mtimeMs,
      group: opts.group || undefined,
      groupIndex: opts.groupIndex,
    };
    this.items = this.items.filter((i) => i !== existing);
    this.items.push(entry);
    sortItems(this.items);
    this.saveIndex();
    this.rescanFolders();
    return entry;
  }

  get(id: string): LibraryItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  content(id: string): Buffer | undefined {
    const item = this.items.find((i) => i.id === id);
    if (!item) return undefined;
    try {
      return readFileSync(join(this.root, relPath(item)));
    } catch {
      return undefined;
    }
  }

  delete(id: string): void {
    const item = this.require(id);
    this.trash(join(this.root, relPath(item)));
    this.items = this.items.filter((i) => i !== item);
    this.saveIndex();
  }

  renameFile(id: string, newName: string): void {
    const item = this.require(id);
    let name = sanitizeName(newName);
    if (!GCODE_EXTENSIONS.includes(extname(name).toLowerCase())) name += extname(item.name) || '.nc';
    if (name === item.name) return;
    const to = join(this.root, item.folder, name);
    if (existsSync(to) && name.toLowerCase() !== item.name.toLowerCase()) throw new Error(`There is already a file called ${name} in this folder`);
    renameSync(join(this.root, relPath(item)), to);
    item.name = name;
    this.saveIndex();
  }

  moveFile(id: string, folder: string): void {
    const item = this.require(id);
    const target = checkFolder(folder, true);
    if (target === item.folder) return;
    if (target && !existsSync(join(this.root, target))) throw new Error(`The folder ${target} doesn't exist`);
    const name = uniqueName(join(this.root, target), item.name);
    renameSync(join(this.root, relPath(item)), join(this.root, target, name));
    item.folder = target;
    item.name = name;
    sortItems(this.items);
    this.saveIndex();
  }

  // ---------------- Folders ----------------

  createFolder(path: string): void {
    const folder = checkFolder(path);
    const abs = join(this.root, folder);
    if (existsSync(abs)) throw new Error(`${folder} already exists`);
    mkdirSync(abs, { recursive: true });
    this.rescanFolders();
  }

  /** Rename or move a folder (`to` is the full new path). */
  renameFolder(path: string, to: string): void {
    const from = checkFolder(path);
    const target = checkFolder(to);
    if (from === target) return;
    if (target.startsWith(`${from}/`)) throw new Error("A folder can't be moved inside itself");
    if (!existsSync(join(this.root, from))) throw new Error(`The folder ${from} doesn't exist`);
    if (existsSync(join(this.root, target))) throw new Error(`${target} already exists`);
    mkdirSync(dirname(join(this.root, target)), { recursive: true });
    renameSync(join(this.root, from), join(this.root, target));
    for (const i of this.items) {
      if (i.folder === from) i.folder = target;
      else if (i.folder.startsWith(`${from}/`)) i.folder = target + i.folder.slice(from.length);
    }
    sortItems(this.items);
    this.saveIndex();
    this.rescanFolders();
  }

  /** Moves the folder and everything in it to the Trash. */
  deleteFolder(path: string): void {
    const folder = checkFolder(path);
    const abs = join(this.root, folder);
    if (!existsSync(abs)) throw new Error(`The folder ${folder} doesn't exist`);
    this.trash(abs);
    this.items = this.items.filter((i) => !inFolder(i.folder, folder));
    this.saveIndex();
    this.rescanFolders();
  }

  filesIn(folder: string): LibraryItem[] {
    return this.items.filter((i) => inFolder(i.folder, folder));
  }

  // ---------------- Macros and config ----------------

  saveMacro(m: Macro): void {
    if (!m.name.trim()) throw new Error('The macro needs a name');
    const macro = { id: m.id || randomId(8), name: m.name.trim(), gcode: m.gcode };
    const i = this.macros.findIndex((x) => x.id === macro.id);
    if (i >= 0) this.macros[i] = macro;
    else this.macros.push(macro);
    this.writeData('macros.json', this.macros);
  }

  deleteMacro(id: string): void {
    this.macros = this.macros.filter((m) => m.id !== id);
    this.writeData('macros.json', this.macros);
  }

  saveConfig(patch: Partial<MachineConfig>): void {
    this.config = { ...this.config, ...patch, probe: { ...this.config.probe, ...patch.probe } };
    this.writeData('config.json', this.config);
  }

  // ---------------- Internals ----------------

  private analyze(buf: Buffer): Omit<LibraryItem, 'id' | 'name' | 'folder' | 'source' | 'size' | 'sha256' | 'addedAt'> | undefined {
    if (!buf.length || buf.includes(0)) return undefined;
    const a = analyzeProgram(buf.toString('utf8'), { keepSegments: false, rapidRate: this.config.rapidRate });
    if (a.streamLines === 0) return undefined;
    return { sourceLines: a.sourceLines, streamLines: a.streamLines, bounds: a.bounds, cutBounds: a.cutBounds, estSeconds: a.estSeconds };
  }

  private require(id: string): Entry {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error('File not found');
    return item;
  }

  /** Refresh the folder list only (cheap). */
  private rescanFolders(): void {
    const dirs: string[] = [];
    const walk = (abs: string, folder: string) => {
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of entries) {
        if (d.name.startsWith('.') || !d.isDirectory()) continue;
        const rel = folder ? `${folder}/${d.name}` : d.name;
        dirs.push(rel);
        walk(join(abs, d.name), rel);
      }
    };
    walk(this.root, '');
    this.folders = dirs.sort((a, b) => a.localeCompare(b));
  }

  /** To the macOS Trash where possible, otherwise to a hidden .Deleted folder in the library. */
  private trash(abs: string): void {
    if (this.trashMode === 'system' && existsSync('/usr/bin/trash')) {
      try {
        execFileSync('/usr/bin/trash', [abs], { stdio: 'ignore' });
        return;
      } catch {
        // fall through
      }
    }
    const dir = join(this.root, DELETED_DIR);
    mkdirSync(dir, { recursive: true });
    renameSync(abs, join(dir, uniqueName(dir, parse(abs).base)));
  }

  /** Copy the files from the old flat store (ids in Application Support) into the folder library, once. */
  private migrateFlatLibrary(): void {
    const old = join(this.dataDir, 'library.json');
    if (!existsSync(old)) return;
    let items: LibraryItem[] = [];
    try {
      items = JSON.parse(readFileSync(old, 'utf8'));
    } catch {
      return;
    }
    for (const it of items) {
      const src = join(this.dataDir, 'files', `${it.id}.nc`);
      if (!existsSync(src) || this.items.some((e) => e.id === it.id)) continue;
      const folder = it.group ? folderName(it.group) : '';
      const dir = join(this.root, folder);
      mkdirSync(dir, { recursive: true });
      const name = uniqueName(dir, withGcodeExtension(sanitizeName(it.name)));
      copyFileSync(src, join(dir, name));
      this.items.push({ ...it, name, folder, mtimeMs: statSync(join(dir, name)).mtimeMs });
    }
    // Keep the old files as a backup; just don't import them again.
    renameSync(old, join(this.dataDir, 'library.migrated.json'));
    this.saveIndex();
  }

  private saveIndex(): void {
    writeFileSync(join(this.root, INDEX_FILE), JSON.stringify({ version: 1, items: this.items }, null, 1));
  }

  private readData<T>(file: string, fallback: T): T {
    const p = join(this.dataDir, file);
    if (!existsSync(p)) return fallback;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  private writeData(file: string, data: unknown): void {
    writeFileSync(join(this.dataDir, file), JSON.stringify(data, null, 2));
  }
}

function relPath(i: { folder: string; name: string }): string {
  return i.folder ? `${i.folder}/${i.name}` : i.name;
}

function inFolder(itemFolder: string, folder: string): boolean {
  return itemFolder === folder || itemFolder.startsWith(`${folder}/`);
}

/** Newest first within each folder; folders in name order. */
function sortItems(items: Entry[]): void {
  items.sort((a, b) => a.folder.localeCompare(b.folder) || b.addedAt - a.addedAt);
}

export function sanitizeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\x00-\x1f:]/g, '').replace(/^\.+/, '').trim().slice(0, 120);
  return clean || `upload-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.nc`;
}

function withGcodeExtension(name: string): string {
  return GCODE_EXTENSIONS.includes(extname(name).toLowerCase()) ? name : `${name}.nc`;
}

/** A single safe folder name from free text (a Swarf group name, say). */
export function folderName(text: string): string {
  return (
    text
      .replace(/[\x00-\x1f/\\:]/g, '-')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 100) || 'Untitled'
  );
}

/** Validate a '/'-separated folder path inside the library. */
export function checkFolder(path: string, allowRoot = false): string {
  const clean = path.trim().replace(/^\/+|\/+$/g, '');
  if (!clean) {
    if (allowRoot) return '';
    throw new Error('The folder needs a name');
  }
  const parts = clean.split('/').map((p) => p.trim());
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || p.startsWith('.') || /[\x00-\x1f\\:]/.test(p) || p.length > 100) {
      throw new Error(`"${clean}" isn't a usable folder name`);
    }
  }
  return parts.join('/');
}

function uniqueName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const { name: stem, ext } = parse(name);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}
