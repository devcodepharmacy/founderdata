import type { ComponentType } from 'react';
import { lazyNamed, type Preloadable } from './lazy';
import { proUi } from './pro';
import type { View } from './sections';

/** The Pro card a core build shows in place of a FounderData Pro section (components/ProUpsell.tsx). */
const Upsell = lazyNamed(() => import('../components/ProUpsell'), 'ProUpsellView');

/**
 * Every page and every Dashboard view is its own chunk, so the entry holds the shell only. Each import() sits here
 * rather than in App.tsx and Dashboard.tsx so that the router (lib/routes.ts), the hover preloader and the idle
 * preloader can load the same chunk the page renders from.
 */
export const Pages = {
  Home: lazyNamed(() => import('../pages/Home'), 'Home'),
  Dashboard: lazyNamed(() => import('../pages/Dashboard'), 'Dashboard'),
  Settings: lazyNamed(() => import('../pages/Settings'), 'Settings'),
  Notifications: lazyNamed(() => import('../pages/Notifications'), 'Notifications'),
  // Connected apps (/apps) is FounderData Pro's: its page in a Pro build (slot `appsPage`), the Pro card in core.
  Apps: proUi?.slots.appsPage ?? Upsell,
  Live: lazyNamed(() => import('../pages/Live'), 'Live'),
  SharePage: lazyNamed(() => import('../pages/SharePage'), 'SharePage'),
  Join: lazyNamed(() => import('../pages/Join'), 'Join'),
  Login: lazyNamed(() => import('../pages/Login'), 'Login'),
};

/** A FounderData Pro section: Pro's own component in a Pro build, the Pro card in core (lib/pro.ts). */
const proView = (v: Exclude<View, 'overview'>) => proUi?.views[v] ?? Upsell;

/** The Dashboard's sections after the Overview, one chunk each. */
export const Views: Record<Exclude<View, 'overview'>, Preloadable<ComponentType<any>>> = {
  content: proView('content'),
  seo: proView('seo'),
  ai: proView('ai'),
  aso: proView('aso'),
  app: proView('app'),
  appstore: proView('appstore'),
  subscriptions: proView('subscriptions'),
  paid: proView('paid'),
  ads: proView('ads'),
  asa: proView('asa'),
  dropoff: proView('dropoff'),
};

/** The command palette loads when it first opens (App.tsx); this is its chunk. */
export const Palette = lazyNamed(() => import('../components/CommandPalette'), 'CommandPalette');
