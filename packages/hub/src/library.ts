// The hub's file library, macros and machine config, persisted as plain files
// so they're easy to back up or inspect.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeProgram, DEFAULT_CONFIG, randomId, type LibraryItem, type MachineConfig, type Macro } from '@gcc/shared';
import { sha256 } from '@gcc/shared/node';

export const GCODE_EXTENSIONS = ['.nc', '.gcode', '.ngc', '.tap', '.gc', '.cnc', '.txt', '.g'];

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
}

export class LibraryStore {
  items: LibraryItem[] = [];
  macros: Macro[] = DEFAULT_MACROS;
  config: MachineConfig = DEFAULT_CONFIG;
  private readonly filesDir: string;

  constructor(private readonly dir: string) {
    this.filesDir = join(dir, 'files');
    mkdirSync(this.filesDir, { recursive: true });
    this.items = this.read('library.json', []);
    this.macros = this.read('macros.json', DEFAULT_MACROS);
    const saved = this.read<Partial<MachineConfig>>('config.json', {});
    this.config = { ...DEFAULT_CONFIG, ...saved, probe: { ...DEFAULT_CONFIG.probe, ...saved.probe } };
    // Drop entries whose file has gone missing.
    this.items = this.items.filter((i) => existsSync(this.path(i.id)));
  }

  private read<T>(file: string, fallback: T): T {
    const p = join(this.dir, file);
    if (!existsSync(p)) return fallback;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  private write(file: string, data: unknown): void {
    writeFileSync(join(this.dir, file), JSON.stringify(data, null, 2));
  }

  private path(id: string): string {
    return join(this.filesDir, `${id}.nc`);
  }

  add(content: Buffer, opts: AddOptions): LibraryItem {
    if (!content.length) throw new Error('The file is empty');
    if (content.includes(0)) throw new Error("That doesn't look like a G-code text file");
    const text = content.toString('utf8');
    const hash = sha256(content);
    const name = sanitizeName(opts.name);

    // Re-sending the same file with the same name just bumps it to the top.
    const existing = this.items.find((i) => i.sha256 === hash && i.name === name);
    if (existing) {
      existing.addedAt = Date.now();
      existing.source = opts.source ?? existing.source;
      existing.group = opts.group ?? existing.group;
      existing.groupIndex = opts.groupIndex ?? existing.groupIndex;
      this.save();
      return existing;
    }

    const a = analyzeProgram(text, { keepSegments: false, rapidRate: this.config.rapidRate });
    if (a.streamLines === 0) throw new Error('The file has no G-code in it');
    const item: LibraryItem = {
      id: randomId(12),
      name,
      source: opts.source || 'Upload',
      size: content.length,
      sha256: hash,
      addedAt: Date.now(),
      sourceLines: a.sourceLines,
      streamLines: a.streamLines,
      bounds: a.bounds,
      cutBounds: a.cutBounds,
      estSeconds: a.estSeconds,
      group: opts.group || undefined,
      groupIndex: opts.groupIndex,
    };
    writeFileSync(this.path(item.id), content);
    this.items.unshift(item);
    this.save();
    return item;
  }

  get(id: string): LibraryItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  content(id: string): Buffer | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    return readFileSync(this.path(id));
  }

  delete(id: string): void {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length === before) throw new Error('File not found');
    rmSync(this.path(id), { force: true });
    this.save();
  }

  saveMacro(m: Macro): void {
    if (!m.name.trim()) throw new Error('The macro needs a name');
    const macro = { id: m.id || randomId(8), name: m.name.trim(), gcode: m.gcode };
    const i = this.macros.findIndex((x) => x.id === macro.id);
    if (i >= 0) this.macros[i] = macro;
    else this.macros.push(macro);
    this.write('macros.json', this.macros);
  }

  deleteMacro(id: string): void {
    this.macros = this.macros.filter((m) => m.id !== id);
    this.write('macros.json', this.macros);
  }

  saveConfig(patch: Partial<MachineConfig>): void {
    this.config = { ...this.config, ...patch, probe: { ...this.config.probe, ...patch.probe } };
    this.write('config.json', this.config);
  }

  private save(): void {
    this.items.sort((a, b) => b.addedAt - a.addedAt);
    this.write('library.json', this.items);
  }
}

export function sanitizeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\x00-\x1f]/g, '').trim().slice(0, 120);
  return clean || `upload-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.nc`;
}
