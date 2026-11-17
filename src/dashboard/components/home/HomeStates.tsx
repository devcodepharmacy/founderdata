import type { ReactNode } from 'react';
import { LogoMark } from '../Logo';
import { basisNote } from '../BasisChip';
import { Skeleton, SkeletonChart, SkeletonRows, StatStrip } from '../ui';
import { InfoIcon, Popover, STATUS_NOTE } from './shared';
import type { SiteRow } from './types';

/** The first load: the shape of Home, block for block, so nothing moves when the numbers arrive. */
export function HomeSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <span className="sr-only">Loading</span>
      <div className="card p-5 lg:col-span-6 lg:h-[360px]" aria-hidden="true">
        <div className="grid gap-8 sm:grid-cols-[1.3fr_1fr]">
          <div>
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="mt-3 h-11 w-48" />
            <Skeleton className="mt-3 h-5 w-32" />
          </div>
          <div className="hidden sm:block">
            <Skeleton className="h-3.5 w-12" />
            <Skeleton className="mt-4 h-8 w-32" />
            <Skeleton className="mt-3 h-5 w-28" />
          </div>
        </div>
        <SkeletonChart height={150} className="mt-8" />
      </div>
      <div className="card hidden h-[360px] p-5 lg:col-span-6 lg:block" aria-hidden="true">
        <Skeleton className="h-3.5 w-16" />
        <Skeleton className="mt-3 h-10 w-28" />
        <SkeletonRows rows={3} className="mt-8 max-w-[45%]" />
      </div>
      <div className="lg:col-span-12" aria-hidden="true">
        <StatStrip>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="px-5 py-4">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="mt-2.5 h-7 w-20" />
              <Skeleton className="mt-2 h-4 w-12" />
            </div>
          ))}
        </StatStrip>
      </div>
      <div className="card p-5 lg:col-span-12" aria-hidden="true">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-2 h-3.5 w-64" />
        <SkeletonRows rows={5} className="mt-5" />
      </div>
    </div>
  );
}

/** A load that failed: the server's message next to a retry, in place of the numbers or above the old ones. */
export function HomeError({ message, onRetry, inline }: { message: string; onRetry: () => void; inline: boolean }) {
  return (
    <div role="alert" className={`card flex flex-wrap items-center gap-x-4 gap-y-2 ${inline ? 'px-4 py-3' : 'flex-col justify-center gap-y-3 px-6 py-14 text-center'}`}>
      {!inline && (
        <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-red-200/60 bg-red-50 text-red-600" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
            <path d="M12 8v5M12 16.5v.5" />
            <circle cx="12" cy="12" r="9" />
          </svg>
        </div>
      )}
      <div className={inline ? 'min-w-0 flex-1' : ''}>
        <p className="text-sm font-medium text-ink">{inline ? 'These numbers did not update.' : 'Home did not load.'}</p>
        <p className="text-[13px] text-red-600">{message}</p>
      </div>
      <button className="btn" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

const GUIDE = 'https://github.com/founderdata/founderdata/blob/main/docs/GUIDE.md';

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-stone-200/80 bg-white text-[13px] font-semibold tabular-nums text-ink shadow-card">{n}</span>
      <div className="pt-0.5">
        <div className="text-sm font-medium text-ink">{title}</div>
        <p className="mt-0.5 text-[13px] leading-relaxed text-stone-500">{children}</p>
      </div>
    </li>
  );
}

/**
 * A deployment with no sites yet. One button opens Add site (the same dialog the header's button opens), and three
 * steps say what happens after it. A read-only login cannot add sites, so it gets the welcome without the button.
 */
export function FirstRun({ viewer, onAdd }: { viewer: boolean; onAdd: () => void }) {
  return (
    <section className="card relative overflow-hidden" aria-labelledby="first-run-title">
      <div aria-hidden="true" className="pointer-events-none absolute -left-32 -top-40 h-96 w-96 rounded-full blur-3xl" style={{ background: 'radial-gradient(circle, rgb(var(--brand) / 0.14), transparent 70%)' }} />
      <div className="relative grid gap-10 px-6 py-10 sm:px-10 sm:py-14 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
        <div>
          <LogoMark size={44} animated />
          <h2 id="first-run-title" className="mt-6 text-display text-ink">
            {viewer ? 'Nothing to show yet' : 'Add your first site or app'}
          </h2>
          <p className="mt-3 max-w-md text-[15px] leading-relaxed text-stone-500">
            {viewer ? 'This login only reads. Visitors and revenue show here once the owner adds a site or app.' : 'Websites, iOS apps, extensions and newsletters land here with their visitors, revenue and MRR.'}
          </p>
          {!viewer && (
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button className="btn-dark h-10 px-5 text-sm" onClick={onAdd}>
                Add site or app
              </button>
              <a className="btn-ghost h-10 px-4 text-sm" href={GUIDE} target="_blank" rel="noreferrer">
                Read the guide
              </a>
            </div>
          )}
        </div>
        <ol className="space-y-6 self-center lg:border-l lg:border-stone-200/60 lg:pl-12">
          <Step n={1} title="Add a website or an iOS app">
            A domain or a bundle id, plus a currency and timezone.
          </Step>
          <Step n={2} title="Install the tracker">
            A script tag, or the Swift package. Copy AI prompt writes the install for your agent.
          </Step>
          <Step n={3} title="Connect payments">
            Stripe, the App Store or RevenueCat, in Settings. Revenue then shows next to its visits.
          </Step>
        </ol>
      </div>
    </section>
  );
}

/** "2 websites, 1 app and 1 newsletter". An app counts here only when it has no website: a site with both is a website. */
export function countLine(sites: SiteRow[]) {
  // Extensions and newsletters count apart from websites (Settings, Product type).
  const typed = (t: string) => sites.filter((s) => s.type === t).length;
  const web = sites.filter((s) => s.kind !== 'app' && s.type !== 'extension' && s.type !== 'newsletter').length;
  const apps = sites.filter((s) => s.kind === 'app').length;
  const parts = [];
  if (web) parts.push(`${web} ${web === 1 ? 'website' : 'websites'}`);
  if (apps) parts.push(`${apps} ${apps === 1 ? 'app' : 'apps'}`);
  if (typed('extension')) parts.push(`${typed('extension')} ${typed('extension') === 1 ? 'browser extension' : 'browser extensions'}`);
  if (typed('newsletter')) parts.push(`${typed('newsletter')} ${typed('newsletter') === 1 ? 'newsletter' : 'newsletters'}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? 'Nothing yet';
}

/** The page's fine print, one click away in the header's button row. */
export function HowCounted({ tz, sites }: { tz: string; sites: SiteRow[] }) {
  const other = sites.filter((s) => s.timezone && s.timezone !== tz);
  return (
    <Popover
      label="How it's counted"
      align="right"
      triggerClass="btn-ghost h-9 gap-1.5 px-2.5 sm:px-3"
      trigger={
        <>
          <InfoIcon size={14} />
          <span className="max-sm:sr-only">How it's counted</span>
        </>
      }
    >
      <div className="mb-2 text-sm font-semibold text-ink">How these numbers are counted</div>
      <ul className="list-disc space-y-1.5 pl-4">
        <li>An app counts on its own only when it has no website. A site with both counts as a website.</li>
        <li>
          Days run on {tz} time, the reporting timezone in Settings. The iPhone and the read API use the same one, so a number here matches theirs.
          {other.length > 0 &&
            ` ${other.map((s) => s.name).join(', ')} ${other.length === 1 ? 'counts' : 'count'} days in ${other.length === 1 ? 'its own timezone' : 'their own timezones'} on ${other.length === 1 ? 'its page' : 'their pages'}, so ${other.length === 1 ? 'its totals' : 'their totals'} there can differ.`}
        </li>
        <li>
          {basisNote(sites.map((s) => s.basis))} Sandbox purchases are left out. Each site counts in its own currency, and FounderData converts payments in other
          currencies at the ECB rate of the payment day.
        </li>
        <li>
          App Store sales come from Apple's daily sales report once FounderData has imported that day, and from the purchases it recorded until then. Apple's days run on
          Pacific time, so a sale late in the evening there can land one day off.
        </li>
        <li>New customers and conversion count recorded payments only. Each conversion rate counts the customers whose payment is linked to a visit on that platform.</li>
        <li>Web and app visitors have their own tiles. Bounce rate and session time are for websites only. Hover the (i) on Web visitors to see them.</li>
        <li>{STATUS_NOTE}</li>
      </ul>
    </Popover>
  );
}
