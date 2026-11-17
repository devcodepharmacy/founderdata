import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

export type ToastTone = 'neutral' | 'ok' | 'error';
interface Item {
  id: number;
  text: string;
  tone: ToastTone;
}

let items: Item[] = [];
let next = 1;
const listeners = new Set<(i: Item[]) => void>();
let mounted = false;

function emit() {
  listeners.forEach((l) => l(items));
}

/** Mounts the toast stack the first time a toast is shown, so no page has to render it. */
function mount() {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  const host = document.createElement('div');
  host.id = 'fd-toasts';
  document.body.appendChild(host);
  createRoot(host).render(<Toaster />);
}

/**
 * A short confirmation at the bottom of the screen for 4 seconds: "Copied", "Saved", "Export failed, try again".
 * For the result of an action the person just took; a lasting problem belongs on the page, next to its cause.
 */
export function toast(text: string, tone: ToastTone = 'neutral', ms = 4000) {
  mount();
  const id = next++;
  items = [...items.slice(-2), { id, text, tone }];
  emit();
  setTimeout(() => {
    items = items.filter((i) => i.id !== id);
    emit();
  }, ms);
}

function Toaster() {
  const [list, setList] = useState<Item[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => void listeners.delete(setList);
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[80] flex flex-col items-center gap-2 px-4" role="status" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          className="pop pointer-events-auto flex max-w-sm items-center gap-2.5 px-3.5 py-2.5 text-[13px] font-medium text-ink"
          style={{ animation: 'fd-dialog-in var(--dur-slower) var(--ease-spring) both' }}
        >
          {t.tone !== 'neutral' && (
            <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${t.tone === 'ok' ? 'bg-emerald-500' : 'bg-red-500'} text-[10px] text-[#fff]`} aria-hidden="true">
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                {t.tone === 'ok' ? <path d="m2.5 6.5 2.5 2.5 4.5-6" /> : <path d="M3 3l6 6M9 3l-6 6" />}
              </svg>
            </span>
          )}
          {t.text}
        </div>
      ))}
    </div>
  );
}
