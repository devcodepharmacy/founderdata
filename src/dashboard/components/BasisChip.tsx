/**
 * What a revenue number adds up, as a small chip next to its label: `basis` from /api/home, the site overview and
 * GET /api/v1/portfolio (revenueBasis in src/worker/revenue.ts). Nothing without revenue.
 */
export type RevenueBasis = 'net_of_refunds' | 'app_store_gross' | 'mixed';

const CHIP: Record<RevenueBasis, { label: string; title: string }> = {
  net_of_refunds: { label: 'net', title: 'Payments net of refunds, before provider fees.' },
  app_store_gross: { label: 'gross', title: "App Store sales at the customer price, before Apple's cut." },
  mixed: { label: 'mixed', title: "Payments net of refunds, plus App Store sales at the customer price, before Apple's cut." },
};

export function BasisChip({ basis }: { basis: RevenueBasis | null | undefined }) {
  if (!basis) return null;
  const c = CHIP[basis];
  return (
    <span
      className="inline-flex items-center rounded-full bg-stone-100 px-1.5 py-px text-[11px] font-medium leading-4 text-stone-500 ring-1 ring-inset ring-stone-200"
      title={c.title}
    >
      {c.label}
    </span>
  );
}

/** The fine print for a set of sites: App Store revenue is gross whenever one of them has some. */
export function basisNote(bases: (RevenueBasis | null | undefined)[]): string {
  const apple = bases.some((b) => b === 'app_store_gross' || b === 'mixed');
  const net = bases.some((b) => b === 'net_of_refunds' || b === 'mixed');
  if (apple && net) return "Payments are after refunds. App Store revenue is gross, at the customer price before Apple's cut, minus refunds.";
  if (apple) return "App Store revenue is gross, at the customer price before Apple's cut, minus refunds.";
  return 'Revenue is after refunds.';
}
