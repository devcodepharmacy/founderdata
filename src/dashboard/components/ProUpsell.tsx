import { useState, type ReactNode } from 'react';
import { amount, isPolarCheckout, type Offer } from '../../shared/offer';
import { PRO_CHECKOUT_URL, PRO_PAGE } from '../../shared/product';
import { PRO_INSTALL_PROMPT } from '../../shared/pro-prompts';
import { useOffer } from '../lib/offer';
import { Code } from './Code';

/** Where the buy button goes: offer.json's checkout when it is a Polar link, else the built-in Polar link. */
export const buyUrl = (offer?: Offer) => (isPolarCheckout(offer?.checkout) ? offer.checkout : PRO_CHECKOUT_URL || PRO_PAGE);

export const eur = (minor: number) => `€${amount(minor)}`;

/** What the buyer pays now: the step's price, or the price after launch. */
export const priceOf = (offer: Offer) => (offer.kind === 'launch' ? offer.price : offer.regular);

/** This step in a few words: "3 left at €4.99", or "€9.99 for the next 10 licenses" when none of it sold yet. */
export function stepText(o: Extract<Offer, { kind: 'launch' }>) {
  return o.soldInStep === 0 ? `${eur(o.price)} for the next ${o.seats} licenses` : `${o.leftInStep} left at ${eur(o.price)}`;
}

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

/**
 * The buy link. Until the price is known it is disabled and goes nowhere, so nobody pays without seeing the price;
 * a failed load counts as known (the price after launch).
 */
export function BuyLink({ offer, className, children }: { offer: Offer | null; className: string; children: ReactNode }) {
  if (!offer)
    return (
      <a className={className} role="link" aria-disabled="true" data-disabled="">
        {children}
      </a>
    );
  return (
    <a className={className} href={buyUrl(offer)} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** The live price in one line, for the compact cards. */
function PriceLine({ offer }: { offer: Offer | null }) {
  // While the offer loads, the line keeps its height and shows no number, so no wrong price flashes.
  if (!offer) return <span className="inline-block h-5 w-56 max-w-full animate-pulse rounded bg-stone-100" aria-hidden="true" />;
  if (offer.kind === 'regular') return <>{eur(offer.regular)} or ${amount(offer.regular)} incl. VAT, paid once.</>;
  const last = offer.next === offer.regular;
  return (
    <>
      <strong className="font-semibold text-ink">{eur(offer.price)}</strong> incl. VAT, paid once. {stepText(offer)}, then {eur(offer.next)}
      {last ? '.' : `, and ${eur(offer.regular)} from license ${offer.firstAfterLaunch}.`}
    </>
  );
}

/** The buy button, the live price and the prompt for an agent that installs Pro once it is bought. */
export function ProActions({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const o = useOffer();
  const offer = o.state === 'ready' ? o.offer : null;
  return (
    <div className={compact ? '' : 'mt-5'}>
      <div className="flex flex-wrap items-center gap-2">
        <BuyLink offer={offer} className="btn btn-dark aria-disabled:pointer-events-none aria-disabled:opacity-60">
          {offer ? `Buy Pro for ${eur(priceOf(offer))}` : 'Buy FounderData Pro'}
        </BuyLink>
        <button className="btn btn-ghost" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
          {open ? 'Hide the install prompt' : 'Already bought? Install Pro'}
        </button>
      </div>
      <p className="mt-2 min-h-5 text-[13px] text-stone-500" aria-live="polite">
        <PriceLine offer={offer} />
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
