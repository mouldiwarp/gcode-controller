// Watches a folder (default ~/GCode Inbox). Any app that can save a file can
// send G-code to the controller by saving it there; once the file has stopped
// growing it is imported and moved to Inbox/imported.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { extname, join, parse } from 'node:path';
import { GCODE_EXTENSIONS } from './library.ts';

export class InboxWatcher {
  private timer?: NodeJS.Timeout;
  private sizes = new Map<string, number>();

  constructor(
    readonly dir: string,
    private readonly onFile: (name: string, content: Buffer) => void,
    private readonly onError: (name: string, err: Error) => void = () => undefined,
  ) {}

  start(intervalMs = 1500): void {
    mkdirSync(join(this.dir, 'imported'), { recursive: true });
    this.timer = setInterval(() => this.scan(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  scan(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.') || !GCODE_EXTENSIONS.includes(extname(name).toLowerCase())) continue;
      const path = join(this.dir, name);
      let size: number;
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        size = st.size;
      } catch {
        continue;
      }
      // Import only once the size has held steady for one scan.
      if (this.sizes.get(name) !== size) {
        this.sizes.set(name, size);
        continue;
      }
      this.sizes.delete(name);
      try {
        this.onFile(name, readFileSync(path));
      } catch (err) {
        this.onError(name, err as Error);
      }
      this.moveToImported(name);
    }
  }

  private moveToImported(name: string): void {
    const { name: stem, ext } = parse(name);
    let target = join(this.dir, 'imported', name);
    for (let n = 2; existsSync(target); n++) target = join(this.dir, 'imported', `${stem} (${n})${ext}`);
    try {
      renameSync(join(this.dir, name), target);
    } catch {
      // leave it; it will be re-imported (deduplicated by hash) next scan
    }
  }
}
