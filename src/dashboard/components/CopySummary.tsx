import { useState } from 'react';
import { api } from '../lib/api';
import { toast } from './ui';

/** GET /api/v1/weekly (src/worker/digest.ts weeklyReport): the Monday report, the part this button copies. */
interface Weekly {
  title: string;
  text: string;
}

/**
 * Home's "Copy summary": last week's report as plain text, ready to paste into Slack. It is the text of
 * GET /api/v1/weekly, so it names the week, the timezone and what revenue adds up, like the Monday push and email.
 */
export function CopySummary() {
  const [state, setState] = useState<'idle' | 'busy' | 'copied' | 'error'>('idle');

  async function copy() {
    setState('busy');
    try {
      const w = await api<Weekly>('/api/v1/weekly');
      await navigator.clipboard.writeText(`${w.title}\n\n${w.text}`);
      setState('copied');
      toast('Copied the weekly summary', 'ok');
    } catch {
      setState('error');
      toast('Could not copy the summary', 'error');
    }
    setTimeout(() => setState('idle'), 2000);
  }

  return (
    <button
      type="button"
      className="btn-ghost h-9 gap-1.5 px-2.5 text-stone-500 hover:text-ink sm:px-3"
      onClick={copy}
      disabled={state === 'busy'}
      title="Copies last week's report, Monday to Sunday, as plain text for Slack or email"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="8" y="8" width="12" height="12" rx="2.5" />
        <path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" />
      </svg>
      <span className="max-sm:sr-only">Copy summary</span>
    </button>
  );
}
