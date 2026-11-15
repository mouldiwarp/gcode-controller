import { useEffect, useRef, useState, type DragEvent } from 'react';
import { formatDuration, type LibraryItem } from '@gcc/shared';
import { useStore } from '../store.ts';
import { ago, baseName, childFolders, countIn, depth, dims, filesIn, GCODE_ACCEPT, parentOf, uploadFiles } from '../libraryUtil.ts';

const FILE_MIME = 'application/x-gcc-file';

/**
 * Organise the library into project folders. The folders are real ones in
 * ~/Documents/GCode Controller on the hub's Mac, so Finder sees the same tree.
 */
export function LibraryManager() {
  const open = useStore((x) => x.managerOpen);
  const setOpen = useStore((x) => x.setManagerOpen);
  if (!open) return null;
  return <ManagerBody onClose={() => setOpen(false)} />;
}

type Mode = { kind: 'none' } | { kind: 'newFolder' } | { kind: 'renameFolder' } | { kind: 'deleteFolder' };

function ManagerBody({ onClose }: { onClose: () => void }) {
  const s = useStore((x) => x.state)!;
  const run = useStore((x) => x.run);
  const toast = useStore((x) => x.toast);
  const [folder, setFolder] = useState('');
  const [mode, setMode] = useState<Mode>({ kind: 'none' });
  const [text, setText] = useState('');
  const [dropTarget, setDropTarget] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const folders = s.folders ?? [];
  const online = s.link.hubConnected;

  // If the selected folder disappears (deleted, renamed in Finder), fall back to its parent.
  useEffect(() => {
    if (folder && !folders.includes(folder)) setFolder(parentOf(folder));
  }, [folders, folder]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (mode.kind !== 'none') setMode({ kind: 'none' });
      else onClose();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, mode]);

  const where = (f: string) => {
    const root = (s.libraryRoot ?? 'GCode Controller').replace(/^\/Users\/[^/]+/, '~');
    return f ? `${root}/${f}` : root;
  };

  const submit = async () => {
    const name = text.trim();
    if (mode.kind === 'newFolder') {
      if (!name) return;
      const path = folder ? `${folder}/${name}` : name;
      if (await run({ type: 'createFolder', path })) {
        setFolder(path);
        setMode({ kind: 'none' });
      }
    } else if (mode.kind === 'renameFolder') {
      if (!name || name === baseName(folder)) return setMode({ kind: 'none' });
      const to = parentOf(folder) ? `${parentOf(folder)}/${name}` : name;
      if (await run({ type: 'renameFolder', path: folder, to })) {
        setFolder(to);
        setMode({ kind: 'none' });
      }
    }
  };

  const deleteFolder = async () => {
    if (await run({ type: 'deleteFolder', path: folder })) {
      toast('info', `Moved ${baseName(folder)} to the Trash`);
      setFolder(parentOf(folder));
      setMode({ kind: 'none' });
    }
  };

  const dropOn = (e: DragEvent, target: string) => {
    e.preventDefault();
    setDropTarget(undefined);
    const id = e.dataTransfer.getData(FILE_MIME);
    if (id) {
      void run({ type: 'moveFile', fileId: id, folder: target });
    } else if (e.dataTransfer.files.length) {
      if (!online) return toast('error', 'The hub is offline, so uploads are unavailable');
      void uploadFiles(e.dataTransfer.files, target, toast);
    }
  };
  const dropProps = (target: string) => ({
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setDropTarget(target);
    },
    onDragLeave: () => setDropTarget((t) => (t === target ? undefined : t)),
    onDrop: (e: DragEvent) => dropOn(e, target),
  });

  const files = filesIn(s.library, folder);
  const subfolders = childFolders(folders, folder);
  const total = countIn(s.library, folder);

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal manager" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <div>
            <div className="eyebrow">Library</div>
            <h2>Projects</h2>
          </div>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
        {!online && <div className="banner warn">The hub is offline. Folders can't be changed until it's back.</div>}

        <div className="manager-body">
          <nav className="tree">
            <div className="tree-tools">
              <button
                className="btn small outline-gold"
                disabled={!online}
                onClick={() => {
                  setText('');
                  setMode({ kind: 'newFolder' });
                }}
                title={folder ? `New folder inside ${baseName(folder)}` : 'New folder'}
              >
                + New folder
              </button>
            </div>
            <TreeRow label="Library" path="" depth={0} count={s.library.length} selected={folder === ''} drop={dropTarget === ''} onSelect={setFolder} {...dropProps('')} />
            {folders.map((f) => (
              <TreeRow
                key={f}
                label={baseName(f)}
                path={f}
                depth={depth(f)}
                count={countIn(s.library, f)}
                selected={folder === f}
                drop={dropTarget === f}
                onSelect={setFolder}
                {...dropProps(f)}
              />
            ))}
            <div className="muted tree-hint">Drag files onto a folder to move them.</div>
          </nav>

          <section className="contents">
            <div className="row contents-head">
              <div style={{ minWidth: 0 }}>
                <div className="folder-title">{folder ? baseName(folder) : 'Library'}</div>
                <div className="muted mono path" title={where(folder)}>
                  {where(folder)}
                </div>
              </div>
              <span className="spacer" />
              {folder && (
                <>
                  <button
                    className="btn small"
                    disabled={!online}
                    onClick={() => {
                      setText(baseName(folder));
                      setMode({ kind: 'renameFolder' });
                    }}
                  >
                    Rename
                  </button>
                  <button className="btn small ghost" disabled={!online} onClick={() => setMode({ kind: 'deleteFolder' })}>
                    Delete
                  </button>
                </>
              )}
              <button className="btn small outline-gold" disabled={!online} onClick={() => input.current?.click()}>
                Upload here
              </button>
              <input
                ref={input}
                type="file"
                multiple
                accept={GCODE_ACCEPT}
                hidden
                onChange={(e) => {
                  if (e.target.files) void uploadFiles(e.target.files, folder, toast);
                  e.target.value = '';
                }}
              />
            </div>

            {(mode.kind === 'newFolder' || mode.kind === 'renameFolder') && (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <span className="muted">{mode.kind === 'newFolder' ? `New folder in ${folder ? baseName(folder) : 'Library'}` : 'Rename to'}</span>
                <input className="input" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Folder name" />
                <button className="btn small primary" type="submit" disabled={!text.trim()}>
                  {mode.kind === 'newFolder' ? 'Create' : 'Rename'}
                </button>
                <button className="btn small ghost" type="button" onClick={() => setMode({ kind: 'none' })}>
                  Cancel
                </button>
              </form>
            )}
            {mode.kind === 'deleteFolder' && (
              <div className="inline-form danger">
                <span>
                  Move <b>{baseName(folder)}</b>
                  {total ? ` and the ${total} file${total === 1 ? '' : 's'} in it` : ''} to the Trash?
                </span>
                <button className="btn small danger" onClick={() => void deleteFolder()}>
                  Move to Trash
                </button>
                <button className="btn small ghost" onClick={() => setMode({ kind: 'none' })}>
                  Cancel
                </button>
              </div>
            )}

            <div className={`contents-list ${dropTarget === folder ? 'drop' : ''}`} {...dropProps(folder)}>
              {subfolders.map((f) => (
                <button key={f} className="subfolder" onDoubleClick={() => setFolder(f)} onClick={() => setFolder(f)}>
                  <span className="folder-icon">▤</span>
                  <span className="folder-name">{baseName(f)}</span>
                  <span className="folder-count">{countIn(s.library, f)} files</span>
                </button>
              ))}
              {files.map((f) => (
                <ManagerFile key={f.id} f={f} folders={folders} online={online} onClose={onClose} />
              ))}
              {!subfolders.length && !files.length && (
                <div className="muted empty">
                  This folder is empty. Drop G-code here, use Upload here, or drag files in from another folder.
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function TreeRow({
  label,
  path,
  depth,
  count,
  selected,
  drop,
  onSelect,
  ...dnd
}: {
  label: string;
  path: string;
  depth: number;
  count: number;
  selected: boolean;
  drop: boolean;
  onSelect: (p: string) => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
}) {
  return (
    <button
      className={`tree-row ${selected ? 'selected' : ''} ${drop ? 'drop' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => onSelect(path)}
      title={path || 'Top level of the library'}
      {...dnd}
    >
      <span className="folder-icon">{path ? '▤' : '◆'}</span>
      <span className="folder-name">{label}</span>
      <span className="folder-count">{count}</span>
    </button>
  );
}

function ManagerFile({ f, folders, online, onClose }: { f: LibraryItem; folders: string[]; online: boolean; onClose: () => void }) {
  const run = useStore((x) => x.run);
  const setPreview = useStore((x) => x.setPreview);
  const previewId = useStore((x) => x.previewId);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(f.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const rename = async () => {
    const n = name.trim();
    if (!n || n === f.name) return setRenaming(false);
    if (await run({ type: 'renameFile', fileId: f.id, name: n })) setRenaming(false);
  };

  return (
    <div
      className={`mfile ${previewId === f.id ? 'selected' : ''}`}
      draggable={online && !renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(FILE_MIME, f.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <div className="mfile-main">
        {renaming ? (
          <form
            className="row"
            style={{ gap: 6 }}
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
            <button className="btn small primary" type="submit">
              Save
            </button>
            <button className="btn small ghost" type="button" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <div className="name" title={f.name}>
            {f.name}
          </div>
        )}
        <div className="meta">
          <span className={`badge ${f.source !== 'Upload' && f.source !== 'Finder' ? 'gold' : ''}`}>{f.source}</span>
          {f.group && <span className="muted">{f.group} #{(f.groupIndex ?? 0) + 1} · </span>}~{formatDuration(f.estSeconds)} · {dims(f)} mm · {ago(f.addedAt)}
        </div>
      </div>
      <div className="mfile-actions">
        {confirmDelete ? (
          <>
            <button className="btn small danger" onClick={() => void run({ type: 'deleteFile', fileId: f.id })}>
              Move to Trash
            </button>
            <button className="btn small ghost" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </>
        ) : (
          <>
            <select
              className="input select"
              value=""
              disabled={!online}
              title="Move to another folder"
              onChange={(e) => {
                const v = e.target.value;
                if (v) void run({ type: 'moveFile', fileId: f.id, folder: v === '/' ? '' : v });
              }}
            >
              <option value="">Move to…</option>
              {f.folder !== '' && <option value="/">Library (top level)</option>}
              {folders
                .filter((x) => x !== f.folder)
                .map((x) => (
                  <option key={x} value={x}>
                    {x.split('/').join(' › ')}
                  </option>
                ))}
            </select>
            <button
              className="btn small"
              disabled={!online}
              onClick={() => {
                setName(f.name);
                setRenaming(true);
              }}
            >
              Rename
            </button>
            <button
              className="btn small"
              onClick={() => {
                setPreview(f.id);
                onClose();
              }}
              title="Show it in the 3D view"
            >
              View
            </button>
            <button className="btn small ghost" disabled={!online} onClick={() => setConfirmDelete(true)} title="Move to the Trash">
              ✕
            </button>
          </>
        )}
      </div>
    </div>
  );
}
