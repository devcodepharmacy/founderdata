import { useState } from 'react';
import { PRO_CHECKOUT_URL, PRO_PAGE, PRO_PRICE } from '../../shared/product';
import { PRO_INSTALL_PROMPT } from '../../shared/pro-prompts';
import { PRO_APPS_PAGE, PRO_LIST, PRO_SECTIONS } from '../lib/proFeatures';
import { matchRoute } from '../lib/routes';
import { Code } from './Code';

const BUY_URL = PRO_CHECKOUT_URL || PRO_PAGE;

/** The buy button and the prompt for an agent that installs Pro once it is bought. */
export function ProActions({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={compact ? '' : 'mt-5'}>
      <div className="flex flex-wrap items-center gap-2">
        <a className="btn btn-dark" href={BUY_URL} target="_blank" rel="noreferrer">
          Get the lifetime license
        </a>
        <button className="btn btn-ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Hide the install prompt' : 'Already bought? Install Pro'}
        </button>
        <span className="text-[13px] text-stone-500">{PRO_PRICE}, paid once</span>
      </div>
      <p className="mt-3 text-[13px] text-stone-500">
        After you pay, connect your GitHub account on Polar's purchase page and accept the invitation GitHub sends you.
        Then come back here and press Install Pro.
      </p>
      {open && (
        <div className="mt-4 text-left">
          <p className="mb-2 text-[13px] text-stone-500">Paste this into the AI agent that manages this deployment (Claude Code, Cursor, Codex). It merges Pro into your copy and keeps your own changes.</p>
          <Code>{PRO_INSTALL_PROMPT}</Code>
        </div>
      )}
    </div>
  );
}

/** What a core build shows in place of a FounderData Pro section. */
export function ProUpsellView() {
  const route = matchRoute(window.location.pathname);
  const section = route.page === 'dashboard' ? PRO_SECTIONS[route.view] : route.page === 'apps' ? PRO_APPS_PAGE : undefined;
  return (
    <div className="card mx-auto my-6 max-w-2xl px-6 py-8">
      <div className="mb-2 inline-flex rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-stone-500">FounderData Pro</div>
      <h2 className="text-title font-medium text-ink">{section?.title ?? 'This section'} is part of FounderData Pro</h2>
      {section && <p className="mt-2 text-sm text-stone-600">{section.body}</p>}
      {section?.collected && <p className="mt-2 text-sm text-stone-600">{section.collected}</p>}
      <p className="mt-4 text-sm text-stone-600">One payment, every future update included. Pro runs on your own Cloudflare account like core, and your data stays there.</p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] text-stone-500">
        {PRO_LIST.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <ProActions />
    </div>
  );
}
