import { useEffect, useRef, useState, type RefObject } from 'react';

const KEY = 'gcc.rightWidth';
const DEFAULT = 360;
const MIN = 300;

function saved(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return n >= MIN ? n : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

/** Widest the right column may go, leaving the 3D view at least 400 px. */
function maxWidth(): number {
  return Math.max(MIN, Math.min(900, window.innerWidth - 300 - 400));
}

/**
 * Drag handle between the 3D view and the right-hand column (job, library, console).
 * The width is remembered in this browser; double-click puts it back to the default.
 */
export function ColumnResizer({ main }: { main: RefObject<HTMLElement> }) {
  const [width, setWidth] = useState(saved);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; w: number }>();

  useEffect(() => {
    main.current?.style.setProperty('--right-w', `${Math.min(width, maxWidth())}px`);
  }, [width, main]);

  useEffect(() => {
    const onResize = () => main.current?.style.setProperty('--right-w', `${Math.min(width, maxWidth())}px`);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [width, main]);

  const commit = (w: number) => {
    setWidth(w);
    try {
      localStorage.setItem(KEY, String(w));
    } catch {
      // private window: the width just isn't remembered
    }
  };

  return (
    <div
      className={`col-resizer ${dragging ? 'dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      title="Drag to widen the job and library column. Double-click to reset."
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: Math.min(width, maxWidth()) };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        // Dragging left widens the right column.
        const w = start.current.w + (start.current.x - e.clientX);
        setWidth(Math.round(Math.max(MIN, Math.min(maxWidth(), w))));
      }}
      onPointerUp={() => {
        start.current = undefined;
        setDragging(false);
        commit(width);
      }}
      onDoubleClick={() => commit(DEFAULT)}
    />
  );
}
