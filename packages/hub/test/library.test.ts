import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LibraryStore } from '../src/library.ts';

const gcode = (n = 3) => Buffer.from(['G21 G90', 'G0 Z5', ...Array.from({ length: n }, (_, i) => `G1 X${i} Y${i} F1000`), 'M30'].join('\n'));
const stores: LibraryStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gcc-lib-'));
  const store = new LibraryStore({ dataDir: join(dir, 'data'), libraryDir: join(dir, 'GCode Controller') });
  stores.push(store);
  return { dir, root: join(dir, 'GCode Controller'), store };
}

/** Write a file as Finder would, dated a few seconds ago so the scan doesn't wait for it to settle. */
function finderWrite(path: string, content: Buffer) {
  writeFileSync(path, content);
  const t = new Date(Date.now() - 5000);
  utimesSync(path, t, t);
}

describe('folder library', () => {
  it('files a Swarf group in a folder named after it, and single files at the top level', () => {
    const { root, store } = setup();
    const a = store.add(gcode(), { name: 'body_1_rough.nc', source: 'Swarf', group: 'Strat body', groupIndex: 0 });
    const b = store.add(gcode(4), { name: 'body_2_finish.nc', source: 'Swarf', group: 'Strat body', groupIndex: 1 });
    const c = store.add(gcode(5), { name: 'dots', source: 'Fretboard' });
    expect(a.folder).toBe('Strat body');
    expect(existsSync(join(root, 'Strat body', 'body_1_rough.nc'))).toBe(true);
    expect(b.folder).toBe('Strat body');
    expect(c).toMatchObject({ folder: '', name: 'dots.nc' }); // an extension is added
    expect(store.folders).toEqual(['Strat body']);
    const d = store.add(gcode(6), { name: 'neck.nc', folder: 'Guitars/Tele' });
    expect(d.folder).toBe('Guitars/Tele');
    expect(store.folders).toEqual(['Guitars', 'Guitars/Tele', 'Strat body']);
  });

  it('replaces a re-exported file in place and keeps the old one in the trash', () => {
    const { root, store } = setup();
    const first = store.add(gcode(3), { name: 'part.nc', folder: 'Jobs' });
    const same = store.add(gcode(3), { name: 'part.nc', folder: 'Jobs' });
    expect(same.id).toBe(first.id);
    expect(store.items).toHaveLength(1);
    const newer = store.add(gcode(8), { name: 'part.nc', folder: 'Jobs' });
    expect(newer.id).toBe(first.id);
    expect(store.items).toHaveLength(1);
    expect(store.content(first.id)!.equals(gcode(8))).toBe(true);
    expect(readdirSync(join(root, '.Deleted'))).toEqual(['part.nc']);
  });

  it('creates, renames, moves into and deletes folders', () => {
    const { root, store } = setup();
    const f = store.add(gcode(), { name: 'pocket.nc' });
    store.createFolder('Guitars');
    store.createFolder('Guitars/Strat');
    expect(() => store.createFolder('Guitars')).toThrow(/already exists/);
    store.moveFile(f.id, 'Guitars/Strat');
    expect(store.get(f.id)).toMatchObject({ folder: 'Guitars/Strat', name: 'pocket.nc' });
    expect(existsSync(join(root, 'Guitars/Strat/pocket.nc'))).toBe(true);

    store.renameFile(f.id, 'Body pocket');
    expect(store.get(f.id)!.name).toBe('Body pocket.nc'); // keeps the extension
    store.renameFolder('Guitars', 'Instruments');
    expect(store.get(f.id)!.folder).toBe('Instruments/Strat');
    expect(store.folders).toEqual(['Instruments', 'Instruments/Strat']);
    expect(store.content(f.id)!.equals(gcode())).toBe(true);
    expect(() => store.renameFolder('Instruments', 'Instruments/Strat/inner')).toThrow(/inside itself/);

    store.deleteFolder('Instruments');
    expect(store.items).toHaveLength(0);
    expect(store.folders).toEqual([]);
    expect(existsSync(join(root, '.Deleted', 'Instruments', 'Strat', 'Body pocket.nc'))).toBe(true);
  });

  it('refuses unsafe folder names', () => {
    const { store } = setup();
    for (const bad of ['..', 'a/../b', '.hidden', '', 'x:y']) expect(() => store.createFolder(bad)).toThrow();
    const f = store.add(gcode(), { name: 'a.nc' });
    expect(() => store.moveFile(f.id, '../outside')).toThrow();
    expect(() => store.moveFile(f.id, 'Missing')).toThrow(/doesn't exist/);
  });

  it('follows files added, moved and removed in Finder', () => {
    const { root, store } = setup();
    mkdirSync(join(root, 'From Finder'));
    finderWrite(join(root, 'From Finder', 'drilled.gcode'), gcode(7));
    writeFileSync(join(root, 'notes.txt'), 'just some notes, no motion here');
    expect(store.rescan()).toBe(true);
    const item = store.items.find((i) => i.name === 'drilled.gcode')!;
    expect(item).toMatchObject({ folder: 'From Finder', source: 'Finder' });
    expect(store.items.some((i) => i.name === 'notes.txt')).toBe(false);
    expect(store.rescan()).toBe(false); // nothing changed

    // A move keeps the id (and so its history and source).
    mkdirSync(join(root, 'Archive'));
    renameSync(join(root, 'From Finder', 'drilled.gcode'), join(root, 'Archive', 'drilled v1.gcode'));
    expect(store.rescan()).toBe(true);
    expect(store.get(item.id)).toMatchObject({ folder: 'Archive', name: 'drilled v1.gcode' });

    rmSync(join(root, 'Archive', 'drilled v1.gcode'));
    store.rescan();
    expect(store.get(item.id)).toBeUndefined();
    expect(store.folders).toEqual(['Archive', 'From Finder']);
  });

  it('notices Finder changes on its own while watching', async () => {
    const { root, store } = setup();
    let changes = 0;
    store.onChange = () => changes++;
    store.watch();
    finderWrite(join(root, 'dropped.nc'), gcode());
    const end = Date.now() + 5000;
    while (!store.items.some((i) => i.name === 'dropped.nc') && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(store.items.some((i) => i.name === 'dropped.nc')).toBe(true);
    expect(changes).toBeGreaterThan(0);
  });

  it('copies the old flat library into folders once, keeping ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gcc-lib-'));
    const data = join(dir, 'data');
    mkdirSync(join(data, 'files'), { recursive: true });
    writeFileSync(join(data, 'files', 'aaa.nc'), gcode(3));
    writeFileSync(join(data, 'files', 'bbb.nc'), gcode(4));
    const old = [
      { id: 'aaa', name: 'side A.nc', source: 'Swarf', group: 'Body', groupIndex: 0, addedAt: 1, size: 0, sha256: 'x', sourceLines: 0, streamLines: 0, bounds: null, cutBounds: null, estSeconds: 0 },
      { id: 'bbb', name: 'dots.nc', source: 'Fretboard', addedAt: 2, size: 0, sha256: 'y', sourceLines: 0, streamLines: 0, bounds: null, cutBounds: null, estSeconds: 0 },
    ];
    writeFileSync(join(data, 'library.json'), JSON.stringify(old));
    const store = new LibraryStore({ dataDir: data, libraryDir: join(dir, 'lib') });
    stores.push(store);
    expect(store.get('aaa')).toMatchObject({ folder: 'Body', name: 'side A.nc', source: 'Swarf', group: 'Body' });
    expect(store.get('bbb')).toMatchObject({ folder: '', name: 'dots.nc', source: 'Fretboard' });
    expect(readFileSync(join(dir, 'lib', 'Body', 'side A.nc')).equals(gcode(3))).toBe(true);
    expect(existsSync(join(data, 'library.migrated.json'))).toBe(true);
    expect(existsSync(join(data, 'files', 'aaa.nc'))).toBe(true); // originals kept as a backup
    // A second start doesn't import again.
    const again = new LibraryStore({ dataDir: data, libraryDir: join(dir, 'lib') });
    stores.push(again);
    expect(again.items).toHaveLength(2);
  });
});
