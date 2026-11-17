import type { ComponentType } from 'react';
import { proUi } from '../edition';
import type { Preloadable } from './lazy';
import type { View } from './sections';

/** FounderData Pro's dashboard, as the build that includes pro/ exports it (pro/dashboard/index.ts). */
export interface ProUi {
  /** The site sections Pro draws. A Pro section missing here shows the Pro card (components/ProUpsell.tsx). */
  views: Partial<Record<View, Preloadable<ComponentType<any>>>>;
  /** Pieces core pages embed by name (components/ProSlot.tsx). A missing slot renders its fallback, usually nothing. */
  slots: Record<string, Preloadable<ComponentType<any>>>;
}

export { proUi };

/** True in a build with FounderData Pro. */
export const isPro = proUi !== null;
