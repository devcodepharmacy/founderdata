import type { ReactNode } from 'react';

/**
 * The empty state of a tab that needs setup first: a faded sample of what the tab shows, what it will show in words,
 * and the exact next step. The SEO and App Store tabs use it.
 */
export function SampleEmpty({ title, intro, features, preview, children }: { title: string; intro: ReactNode; features: string[]; preview: ReactNode; children: ReactNode }) {
  return (
    <div className="card overflow-hidden">
      <div className="relative h-[260px] overflow-hidden border-b border-stone-200/60" aria-hidden="true">
        <div className="pointer-events-none select-none p-5 opacity-80 blur-[1px]">{preview}</div>
        <div className="absolute inset-0 bg-gradient-to-b from-transparent from-50% to-white" />
        <span className="absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-stone-200/80 bg-white px-3 py-1 text-xs font-medium text-stone-500 shadow-card">
          Sample data
        </span>
      </div>
      <div className="mx-auto max-w-3xl px-6 pb-8 pt-2">
        <div className="text-center">
          <h2 className="text-title text-ink">{title}</h2>
          <p className="mx-auto mt-1.5 max-w-xl text-[13px] text-stone-500">{intro}</p>
        </div>
        <ul className="mt-5 grid gap-x-6 gap-y-2 text-[13px] text-stone-600 sm:grid-cols-2">
          {features.map((f) => (
            <li key={f} className="flex gap-2">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-visitors" aria-hidden="true" />
              {f}
            </li>
          ))}
        </ul>
        <div className="mt-6 space-y-3 text-[13px] text-stone-600">{children}</div>
      </div>
    </div>
  );
}

/** A tile of the sample: label and a made-up number. */
export function SampleTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-stone-200/60 px-4 py-3">
      <div className="text-[13px] font-medium text-stone-500">{label}</div>
      <div className="mt-0.5 text-stat text-ink">{value}</div>
    </div>
  );
}

/** A made-up chart: a line, bars, or both. */
export function SampleChart({ line = true, bars = false }: { line?: boolean; bars?: boolean }) {
  const ys = [64, 52, 58, 40, 46, 30, 42, 26, 34, 18, 30, 14, 22, 10];
  const step = 600 / (ys.length - 1);
  const path = ys.map((y, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(0)},${y}`).join(' ');
  return (
    <svg viewBox="0 0 600 80" preserveAspectRatio="none" className="h-20 w-full">
      {bars &&
        ys.map((y, i) => (
          <rect key={i} x={i * step - 10 + (i === 0 ? 10 : 0)} y={y + 4} width={i === 0 || i === ys.length - 1 ? 10 : 20} height={80 - y - 4} rx={3} className="fill-revenue" opacity={0.7} />
        ))}
      {line && (
        <>
          <path d={`${path} L600,80 L0,80 Z`} className="fill-visitorsSoft" />
          <path d={path} fill="none" className="stroke-visitors" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  );
}

/** Rows of the sample: a label and a bar. */
export function SampleRows({ rows }: { rows: [string, number][] }) {
  return (
    <div className="space-y-1.5">
      {rows.map(([label, share]) => (
        <div key={label} className="relative flex h-8 items-center rounded-lg px-3 text-sm">
          <div className="absolute inset-y-0 left-0 rounded-lg bg-visitorsSoft" style={{ width: `${share}%` }} />
          <span className="relative">{label}</span>
        </div>
      ))}
    </div>
  );
}
