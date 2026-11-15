import { useRef, useState, type DragEvent } from 'react';
import { formatDuration, type LibraryItem } from '@gcc/shared';
import { jobActive, nextGroupFile, useStore } from '../store.ts';
import {
  ago,
  baseName,
  childFolders,
  countIn,
  dims,
  filesIn,
  GCODE_ACCEPT,
  loadOpenFolders,
  saveOpenFolders,
  uploadFiles,
} from '../libraryUtil.ts';

/** The library beside the job controls: project folders, each opening to its files. */
export function LibraryPanel() {
  const s = useStore((x) => x.state)!;
  const toast = useStore((x) => x.toast);
  const setManagerOpen = useStore((x) => x.setManagerOpen);
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState(loadOpenFolders);
  const input = useRef<HTMLInputElement>(null);
  const canUpload = s.link.hubConnected;
  const folders = s.folders ?? [];

  const toggle = (f: string) => {
    const next = new Set(open);
    if (next.has(f)) next.delete(f);
    else next.add(f);
    setOpen(next);
    saveOpenFolders(next);
  };

  const onDrop = (e: DragEvent, folder: string) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    if (!canUpload) return toast('error', 'The hub is offline, so uploads are unavailable');
    if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files, folder, toast);
  };

  return (
    <section
      className="panel"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => onDrop(e, '')}
    >
      <h3 className="panel-title">
        <span>Library</span>
        <span className="row" style={{ gap: 6 }}>
          <button className="btn small ghost" onClick={() => setManagerOpen(true)} title="Organise projects into folders">
            Manage
          </button>
          <button className="btn small outline-gold" disabled={!canUpload} onClick={() => input.current?.click()}>
            Upload
          </button>
        </span>
      </h3>
      <input
        ref={input}
        type="file"
        multiple
        accept={GCODE_ACCEPT}
        hidden
        onChange={(e) => {
          if (e.target.files) void uploadFiles(e.target.files, '', toast);
          e.target.value = '';
        }}
      />
      <div className={`dropzone ${over ? 'over' : ''}`}>
        {canUpload ? 'Drop G-code here or on a folder · or send from Swarf / Fretboard Modeller' : 'Hub offline: showing cached files'}
      </div>
      <div className="files">
        {s.library.length === 0 && folders.length === 0 && <div className="muted" style={{ fontSize: 12, padding: 8 }}>No files yet.</div>}
        <FileList files={filesIn(s.library, '')} />
        {childFolders(folders, '').map((f) => (
          <FolderNode key={f} folder={f} open={open} toggle={toggle} onDrop={onDrop} />
        ))}
      </div>
    </section>
  );
}

function FolderNode({
  folder,
  open,
  toggle,
  onDrop,
}: {
  folder: string;
  open: Set<string>;
  toggle: (f: string) => void;
  onDrop: (e: DragEvent, folder: string) => void;
}) {
  const s = useStore((x) => x.state)!;
  const [over, setOver] = useState(false);
  const isOpen = open.has(folder);
  const n = countIn(s.library, folder);
  return (
    <div className="folder-node">
      <button
        className={`folder-head ${over ? 'over' : ''}`}
        onClick={() => toggle(folder)}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          onDrop(e, folder);
        }}
        title={over ? `Upload into ${folder}` : folder}
      >
        <span className={`chev ${isOpen ? 'open' : ''}`}>▸</span>
        <span className="folder-icon">▤</span>
        <span className="folder-name">{baseName(folder)}</span>
        <span className="folder-count">{n}</span>
      </button>
      {isOpen && (
        <div className="folder-children">
          <FileList files={filesIn(s.library, folder)} />
          {childFolders(s.folders ?? [], folder).map((f) => (
            <FolderNode key={f} folder={f} open={open} toggle={toggle} onDrop={onDrop} />
          ))}
          {n === 0 && <div className="muted" style={{ fontSize: 11, padding: '4px 8px' }}>Empty</div>}
        </div>
      )}
    </div>
  );
}

function FileList({ files }: { files: LibraryItem[] }) {
  let lastGroup: string | undefined;
  return (
    <>
      {files.map((f) => {
        const label = f.group && f.group !== lastGroup && f.group !== baseName(f.folder) ? f.group : undefined;
        lastGroup = f.group;
        return (
          <div key={f.id} style={{ display: 'contents' }}>
            {label && <div className="group-label">{label}</div>}
            <FileRow f={f} />
          </div>
        );
      })}
    </>
  );
}

function FileRow({ f }: { f: LibraryItem }) {
  const s = useStore((x) => x.state)!;
  const run = useStore((x) => x.run);
  const previewId = useStore((x) => x.previewId);
  const setPreview = useStore((x) => x.setPreview);
  const askStart = useStore((x) => x.askStart);
  const active = jobActive(s);
  const waitingForBit = !!nextGroupFile(s);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className={`file ${previewId === f.id ? 'selected' : ''}`} onClick={() => setPreview(f.id)}>
      <div className="name" title={f.name}>
        {f.name}
      </div>
      <div className="meta">
        <span className={`badge ${f.source !== 'Upload' && f.source !== 'Finder' ? 'gold' : ''}`}>{f.source}</span>~{formatDuration(f.estSeconds)} · {dims(f)} mm ·{' '}
        {ago(f.addedAt)}
      </div>
      <div className="actions">
        {confirmDelete ? (
          <>
            <button
              className="btn small danger"
              title="Move this file to the Trash"
              onClick={(e) => {
                e.stopPropagation();
                if (previewId === f.id) setPreview(undefined);
                void run({ type: 'deleteFile', fileId: f.id });
              }}
            >
              Trash
            </button>
            <button
              className="btn small ghost"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDelete(false);
              }}
            >
              Keep
            </button>
          </>
        ) : (
          <>
            <button
              className="btn small primary"
              disabled={active || waitingForBit}
              title={waitingForBit ? 'A group is waiting for a bit change: use Start next or End group' : 'Start this file'}
              onClick={(e) => {
                e.stopPropagation();
                setPreview(f.id);
                askStart(f.id);
              }}
            >
              ▶
            </button>
            <button
              className="btn small ghost"
              disabled={!s.link.hubConnected}
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDelete(true);
              }}
            >
              ✕
            </button>
          </>
        )}
      </div>
    </div>
  );
}
