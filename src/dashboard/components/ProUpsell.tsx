import { useState } from 'react';
import { amount, type Offer } from '../../shared/offer';
import { PRO_CHECKOUT_URL, PRO_PAGE } from '../../shared/product';
import { PRO_INSTALL_PROMPT } from '../../shared/pro-prompts';
import { useOffer } from '../lib/offer';
import { Code } from './Code';

/** Where the buy button goes: offer.json's checkout when it names one, else the built-in Polar link. */
export const buyUrl = (offer?: Offer) => offer?.checkout || PRO_CHECKOUT_URL || PRO_PAGE;

/** The steps between paying and installing, for every Pro card. */
export const AFTER_PAYING =
  "After you pay, connect your GitHub account on Polar's purchase page and accept the invitation GitHub sends you. Then come back here and press Install Pro.";

/** The prompt that installs Pro, for the agent that manages this deployment. */
export function InstallPrompt() {
  return (
    <div className="text-left">
      <p className="mb-2 text-[13px] text-stone-500">
        Paste this into the AI agent that manages this deployment (Claude Code, Cursor, Codex). It installs Pro and keeps
        your own changes.
      </p>
      <Code>{PRO_INSTALL_PROMPT}</Code>
    </div>
  );
}

/** The live price in one line: the launch price against the regular one, or the regular price alone. */
function PriceLine() {
  const o = useOffer();
  // While the offer loads, the line keeps its height and shows no number, so no wrong price flashes.
  if (o.state === 'loading') return <span className="inline-block h-5 w-56 animate-pulse rounded bg-stone-100" aria-label="Loading the price" />;
  const offer = o.offer;
  if (offer.kind === 'regular') return <span className="text-[13px] text-stone-500">€{amount(offer.regular)} or ${amount(offer.regular)}, paid once</span>;
  return (
    <span className="text-[13px] text-stone-500">
      <s className="text-stone-400">€{amount(offer.regular)}</s> <strong className="font-semibold text-ink">€{amount(offer.price)}</strong>, paid once.{' '}
      {offer.leftInStep} of {offer.seats} left at this price, then €{amount(offer.next)}.
    </span>
  );
}

/** The buy button, the live price and the prompt for an agent that installs Pro once it is bought. */
export function ProActions({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const o = useOffer();
  return (
    <div className={compact ? '' : 'mt-5'}>
      <div className="flex flex-wrap items-center gap-2">
        <a className="btn btn-dark" href={buyUrl(o.state === 'ready' ? o.offer : undefined)} target="_blank" rel="noreferrer">
          Get the lifetime license
        </a>
        <button className="btn btn-ghost" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
          {open ? 'Hide the install prompt' : 'Already bought? Install Pro'}
        </button>
      </div>
      <p className="mt-2 min-h-5">
        <PriceLine />
      </p>
      <p className="mt-2 text-[13px] text-stone-500">{AFTER_PAYING}</p>
      {open && (
        <div className="mt-4">
          <InstallPrompt />
        </div>
      )}
    </div>
  );
}
