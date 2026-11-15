// Shared by the Library panel and the Library manager.

import type { LibraryItem } from '@gcc/shared';

export const GCODE_ACCEPT = '.nc,.gcode,.ngc,.tap,.gc,.cnc,.txt,.g';

/** Upload files into a library folder ('' for the top level). */
export async function uploadFiles(
  files: FileList | File[],
  folder: string,
  toast: (level: 'info' | 'error', text: string) => void,
): Promise<void> {
  for (const f of Array.from(files)) {
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        body: await f.text(),
        headers: {
          'X-Filename': encodeURIComponent(f.name),
          'X-Source': 'Upload',
          'X-Folder': encodeURIComponent(folder),
          'Content-Type': 'text/plain',
        },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast('error', `${f.name}: ${body.error ?? res.statusText}`);
      }
    } catch (err) {
      toast('error', `${f.name}: ${(err as Error).message}`);
    }
  }
}

export function baseName(folder: string): string {
  return folder.split('/').pop() ?? folder;
}

export function parentOf(folder: string): string {
  const i = folder.lastIndexOf('/');
  return i < 0 ? '' : folder.slice(0, i);
}

export function depth(folder: string): number {
  return folder ? folder.split('/').length : 0;
}

/** Folders directly inside `parent`. */
export function childFolders(folders: string[], parent: string): string[] {
  return folders.filter((f) => parentOf(f) === parent);
}

/** Files directly in `folder`, groups together in run order, newest first otherwise. */
export function filesIn(library: LibraryItem[], folder: string): LibraryItem[] {
  const files = library.filter((f) => (f.folder ?? '') === folder);
  return files.sort((a, b) => {
    if (a.group && a.group === b.group) return (a.groupIndex ?? 0) - (b.groupIndex ?? 0);
    return b.addedAt - a.addedAt;
  });
}

/** Number of files in a folder and everything below it. */
export function countIn(library: LibraryItem[], folder: string): number {
  return library.filter((f) => f.folder === folder || f.folder?.startsWith(`${folder}/`)).length;
}

export function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

export function dims(f: LibraryItem): string {
  const b = f.cutBounds ?? f.bounds;
  return b ? `${(b.max[0] - b.min[0]).toFixed(0)}×${(b.max[1] - b.min[1]).toFixed(0)}×${(b.max[2] - b.min[2]).toFixed(1)}` : '';
}

/** Remembered open/closed folders in this browser. */
const OPEN_KEY = 'gcc.openFolders';
export function loadOpenFolders(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}
export function saveOpenFolders(open: Set<string>): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
  } catch {
    // private mode
  }
}
