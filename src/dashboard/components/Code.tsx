import { useState } from 'react';

/** A dark code block with a Copy button that confirms in place. */
export function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative">
      <code className="code pr-20">{children}</code>
      <button
        className="absolute right-2 top-2 inline-flex h-7 items-center gap-1.5 rounded-lg bg-[#24262c] px-2 text-xs font-medium text-[#e8e8e6] shadow-[-8px_0_12px_4px_#141518] ring-1 ring-inset ring-[#ffffff14] transition-[background-color,transform] duration-fast hover:bg-[#2e3037] active:scale-95"
        onClick={() => {
          navigator.clipboard.writeText(children);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        aria-label={copied ? 'Copied' : 'Copy code'}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" key={String(copied)} style={{ animation: 'fd-dot-in var(--dur-slow) var(--ease-out) both' }}>
          {copied ? <path d="m5 12.5 4.5 4.5L19 7.5" /> : <path d="M9 9h10v10H9zM5 15V5h10" />}
        </svg>
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  );
}
