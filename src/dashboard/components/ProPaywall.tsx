import { useEffect, useRef, useState } from 'react';
import { amount, type Offer } from '../../shared/offer';
import { useOffer } from '../lib/offer';
import { PRO_APPS_PAGE, PRO_CARDS, PRO_SECTIONS } from '../lib/proFeatures';
import { matchRoute } from '../lib/routes';
import { PageBar } from './home/PageBar';
import { AFTER_PAYING, buyUrl, InstallPrompt } from './ProUpsell';
import './ProPaywall.css';

type Card = (typeof PRO_CARDS)[number][number];

function FeatureCard({ card: [group, name, line] }: { card: Card }) {
  return (
    <div className="fd-pw-card">
      <small>{group}</small>
      <h3>{name}</h3>
      <p>{line}</p>
    </div>
  );
}

/**
 * A column of feature cards that scrolls in a loop. The list is drawn twice so the loop is seamless; each list is
 * taller than the stage, so a card never shows twice at once. Decorative: the same features are in a list for screen
 * readers.
 */
function Stream({ cards, className }: { cards: Card[]; className: string }) {
  const list = (copy: number) => (
    <div className="fd-pw-list" key={copy}>
      {cards.map((c) => (
        <FeatureCard key={c[1]} card={c} />
      ))}
    </div>
  );
  return (
    <div className={className} aria-hidden="true">
      <div className="fd-pw-track">{[list(0), list(1)]}</div>
    </div>
  );
}

const eur = (minor: number) => `€${amount(minor)}`;

/** The receipt: the regular price, the launch saving, the total, the licenses left at this price and the pay button. */
function Receipt({ offer, onInstall }: { offer: Offer | null; onInstall: () => void }) {
  const launch = offer?.kind === 'launch' ? offer : null;
  const total = offer ? (launch ? launch.price : offer.regular) : null;
  return (
    <div className="fd-pw-panel">
      <div className="fd-pw-bar">
        <b data-live={launch ? '' : undefined}>{launch ? 'Launch price' : 'Lifetime license'}</b>
        <span>No subscription</span>
      </div>
      <div className="fd-pw-in">
        {!offer ? (
          <div className="fd-pw-wait" aria-label="Loading the price" role="status">
            <i />
            <i />
            <i />
            <i />
            <i className="fd-pw-wait-total" />
          </div>
        ) : (
          <>
            <div className="fd-pw-line">
              <span>Lifetime license</span>
              {launch ? <s>{eur(launch.regular)}</s> : <span>{eur(offer.regular)}</span>}
            </div>
            {launch && (
              <div className="fd-pw-line">
                <span>Launch saving</span>
                <span className="fd-pw-g">−{eur(launch.saving)}</span>
              </div>
            )}
            <div className="fd-pw-line">
              <span>Every future update</span>
              <span className="fd-pw-g">included</span>
            </div>
            <div className="fd-pw-line">
              <span>All your sites and apps</span>
              <span className="fd-pw-g">no fee per site</span>
            </div>
            <div className="fd-pw-total">
              <span>You pay once</span>
              <strong>{eur(total!)}</strong>
            </div>
          </>
        )}
        {launch && (
          <>
            <div
              className="fd-pw-meter"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={launch.seats}
              aria-valuenow={launch.leftInStep}
              aria-label={`${launch.leftInStep} of ${launch.seats} left at this price`}
            >
              <i style={{ width: `${(launch.leftInStep / launch.seats) * 100}%` }} />
            </div>
            <div className="fd-pw-cap">
              <span>
                <strong>
                  {launch.leftInStep} of {launch.seats} left
                </strong>{' '}
                at this price
              </span>
              <span>Then {eur(launch.next)}</span>
            </div>
          </>
        )}
        <a className="fd-pw-cta" href={buyUrl(offer ?? undefined)} target="_blank" rel="noreferrer">
          {total === null ? 'Buy FounderData Pro' : `Buy Pro for ${eur(total)}`}
        </a>
        <p className="fd-pw-fine">
          {total === null ? 'Polar handles the checkout and tax.' : `Or $${amount(total)}. Polar handles the checkout and tax.`}{' '}
          <button type="button" onClick={onInstall}>
            Already bought? Install Pro
          </button>
        </p>
      </div>
    </div>
  );
}

/** Pauses the streams while the stage is off screen. */
function useOnScreen<T extends Element>() {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, on] as const;
}

/**
 * What a core build shows in place of a FounderData Pro section: which report the tab holds, the live launch price as
 * a receipt, and Pro's features streaming past on both sides. The stage is dark in both themes, one object that is
 * the same wherever it shows; the install card under it follows the theme.
 */
export function ProUpsellView() {
  const route = matchRoute(window.location.pathname);
  const section = route.page === 'dashboard' ? PRO_SECTIONS[route.view] : route.page === 'apps' ? PRO_APPS_PAGE : undefined;
  const o = useOffer();
  const offer = o.state === 'ready' ? o.offer : null;
  const [install, setInstall] = useState(false);
  const installRef = useRef<HTMLDivElement>(null);
  const [stage, onScreen] = useOnScreen<HTMLElement>();

  function openInstall() {
    setInstall(true);
    requestAnimationFrame(() => installRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  const view = (
    <div className="fd-pw-wrap">
      <section className="fd-pw" ref={stage} data-paused={onScreen ? undefined : ''} aria-labelledby="fd-pw-title">
        <Stream cards={PRO_CARDS[0]} className="fd-pw-side fd-pw-up" />
        <div className="fd-pw-mid">
          <h2 id="fd-pw-title">
            {section?.title ?? 'This section'} is part of <em>FounderData Pro</em>
          </h2>
          {section && (
            <p className="fd-pw-lede">
              {section.body} {section.collected && <span>{section.collected}</span>}
            </p>
          )}
          <Receipt offer={offer} onInstall={openInstall} />
          <ul className="fd-pw-proof">
            <li>Your AI agent installs it from a prompt</li>
            <li>Your own changes stay</li>
          </ul>
          {offer && (
            <p className="fd-pw-why">
              {offer.kind === 'launch' && `${eur(offer.price)} is a launch price for the first buyers. It rises in steps to ${eur(offer.regular)}. `}
              The code runs on your own Cloudflare account, so it keeps running even if updates stop.
            </p>
          )}
        </div>
        <Stream cards={PRO_CARDS[1]} className="fd-pw-side fd-pw-down" />
        <Stream cards={[...PRO_CARDS[0], ...PRO_CARDS[1]]} className="fd-pw-strip" />
        <ul className="sr-only">
          {[...PRO_CARDS[0], ...PRO_CARDS[1]].map(([, name, line]) => (
            <li key={name}>
              {name}: {line}
            </li>
          ))}
        </ul>
      </section>

      <div ref={installRef} className="card mt-4 scroll-mt-32 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-[13px] text-stone-500">{AFTER_PAYING}</p>
          <button className="btn" onClick={() => setInstall((x) => !x)} aria-expanded={install}>
            {install ? 'Hide the install prompt' : 'Already bought? Install Pro'}
          </button>
        </div>
        {install && (
          <div className="mt-4">
            <InstallPrompt />
          </div>
        )}
      </div>
    </div>
  );
  // Connected apps is a page of its own, not a section inside the site dashboard, so it brings the page bar.
  if (route.page !== 'apps') return view;
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-3 sm:px-6 sm:pt-4">
      <PageBar current="apps" />
      <div className="mt-5 sm:mt-8">{view}</div>
    </div>
  );
}
