import { Suspense, type ReactNode } from 'react';
import { proUi } from '../lib/pro';

/**
 * A piece of FounderData Pro inside a core page, by name (pro/dashboard/index.ts `slots`). Without Pro, or when Pro
 * has no slot by that name, it renders `fallback`, which is nothing unless the page passes a Pro card.
 */
export function ProSlot({ name, fallback = null, loading = null, ...props }: { name: string; fallback?: ReactNode; loading?: ReactNode } & Record<string, any>) {
  const Slot = proUi?.slots[name];
  if (!Slot) return <>{fallback}</>;
  return (
    <Suspense fallback={loading}>
      <Slot {...props} />
    </Suspense>
  );
}
