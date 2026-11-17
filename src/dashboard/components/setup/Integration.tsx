import { createContext, useContext, type ReactNode } from 'react';
import type { Site } from '../../lib/api';
import { IntegrationCard } from './kit';
import { useCardStatus } from './status';

/** Which integration cards are open. Settings owns it, so a hash like #stripe can open one from outside. */
export const OpenCtx = createContext<{ open: Set<string>; toggle: (id: string) => void }>({ open: new Set(), toggle: () => undefined });

/** An integration card wired to the page: its chip from the shared status, open and closed from Settings. */
export function Integration({ id, site, mark, title, desc, children }: { id: string; site: Site; mark: ReactNode; title: string; desc: ReactNode; children: ReactNode }) {
  const { open, toggle } = useContext(OpenCtx);
  const status = useCardStatus(id, site);
  return (
    <IntegrationCard id={id} mark={mark} title={title} desc={desc} status={status} open={open.has(id)} onToggle={() => toggle(id)}>
      {children}
    </IntegrationCard>
  );
}
