import { useId, useState } from 'react';
import { TRAIL_PATH } from './Logo';
import { Modal } from './Modal';

/**
 * Stripe Payment Link, pay what you want in EUR (preset 5, minimum 1). It sits in the maintainer's Stripe account and tags
 * every payment with metadata rt_site_id=donation, so no site's Stripe webhook records a donation as its revenue.
 */
export const DONATE_URL = 'https://donate.stripe.com/5kQ14p3Ui2gE9vL6DG04800';

export function HeartIcon({ size = 18, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20.5s-7.5-4.6-9.2-9.4C1.6 7.6 3.9 4 7.4 4c2 0 3.5 1.1 4.6 2.7C13.1 5.1 14.6 4 16.6 4c3.5 0 5.8 3.6 4.6 7.1-1.7 4.8-9.2 9.4-9.2 9.4z" />
    </svg>
  );
}

/** The logo's trail, rising into a heart instead of the paying visit. */
function TrailToHeart() {
  const id = useId();
  return (
    <svg width="150" height="122" viewBox="120 90 860 700" aria-hidden="true">
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="170" y1="774" x2="850" y2="224">
          <stop offset="0" stopColor="var(--chart-axis)" stopOpacity="0.15" />
          <stop offset="0.75" stopColor="rgb(var(--revenue))" />
        </linearGradient>
      </defs>
      <path d={TRAIL_PATH} fill="none" stroke={`url(#${id})`} strokeLinecap="round" strokeLinejoin="round" strokeWidth="56" />
      <g transform="translate(742 112) scale(9)">
        <path
          d="M12 20.5s-7.5-4.6-9.2-9.4C1.6 7.6 3.9 4 7.4 4c2 0 3.5 1.1 4.6 2.7C13.1 5.1 14.6 4 16.6 4c3.5 0 5.8 3.6 4.6 7.1-1.7 4.8-9.2 9.4-9.2 9.4z"
          fill="rgb(var(--revenue))"
          stroke="var(--chart-dot-ring)"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

/**
 * A heart button for the header of every screen. It opens a short card with the donation link; `compact` shows the
 * heart alone, for the crowded site toolbar.
 */
export function SupportButton({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={`btn group text-stone-600 hover:border-revenue/40 hover:bg-revenueSoft/40 hover:text-ink ${compact ? 'h-9 w-9 px-0' : ''}`}
        onClick={() => setOpen(true)}
        aria-label="Support FounderData"
        title="Support FounderData"
      >
        <span className="text-revenue transition-transform duration-200 group-hover:scale-110">
          <HeartIcon size={compact ? 15 : 15} filled />
        </span>
        {!compact && 'Support'}
      </button>
      <SupportDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** The donation card on its own, for a menu item that opens it (the home page's account menu). */
export function SupportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} width="max-w-md">
      <div className="-m-6 overflow-hidden rounded-2xl">
        <div className="relative flex justify-center bg-gradient-to-b from-revenueSoft/70 to-white px-6 pb-2 pt-8">
          <button
            className="absolute right-3 top-3 rounded-lg p-1 text-stone-400 hover:bg-white/70 hover:text-stone-700"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
          <TrailToHeart />
        </div>
        <div className="px-7 pb-7 pt-3 text-center">
          <h2 className="text-xl font-semibold tracking-tight">Support FounderData</h2>
          <p className="mx-auto mt-2 max-w-xs text-[15px] leading-relaxed text-stone-600">
            If FounderData helps you see which source brings in the money, you can chip in. Pick any amount from €1.
          </p>
          <a
            href={DONATE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-revenue px-4 py-3 text-base font-semibold text-[#fff] shadow-card transition hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-revenue/40"
            onClick={onClose}
          >
            <HeartIcon size={18} filled /> Donate
          </a>
          <p className="mt-3 text-xs text-stone-400">Stripe handles the payment in a new tab.</p>
        </div>
      </div>
    </Modal>
  );
}
