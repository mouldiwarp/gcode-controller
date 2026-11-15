import { useStore } from '../store.ts';

export function Toasts() {
  const toasts = useStore((x) => x.toasts);
  const dismiss = useStore((x) => x.dismiss);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
