import type { View } from './sections';

/** What each FounderData Pro section does, for the Pro card a core build shows in its place (components/ProUpsell.tsx). */
export const PRO_SECTIONS: Partial<Record<View, { title: string; body: string; collected?: string }>> = {
  content: {
    title: 'Content',
    body: 'Every page with its visitors, Google clicks and position, the revenue it brought, and the pages losing traffic.',
  },
  dropoff: {
    title: 'Drop-off',
    body: 'Where sessions stop before they buy, on the website and in the app: every session, the paywall, checkout, bought.',
    collected: 'Core already stores the goals this view reads.',
  },
  app: {
    title: 'App analytics',
    body: 'Sessions, screens, the onboarding funnel with drop-off per step, paywall conversion, and day-1 and day-7 retention for your iOS app.',
    collected: 'Core already stores the events FounderDataKit sends, so the reports show your history the day you switch.',
  },
  seo: {
    title: 'SEO',
    body: 'Search Console queries and pages, Google rank tracking, decay, opportunities, cannibalization and a page audit.',
  },
  ai: {
    title: 'AI visibility',
    body: 'Ask ChatGPT, Claude, Gemini and Perplexity your prompts every day and see the mention rate, share of voice and the pages they cite.',
  },
  aso: {
    title: 'ASO',
    body: 'App Store rank per keyword and country, the 10 apps above you, difficulty, search popularity, ratings and new reviews.',
  },
  paid: {
    title: 'Paid overview',
    body: 'Spend from every ad channel against every new customer: MER, blended CAC, ROAS per channel and the days until spend paid back.',
  },
  ads: {
    title: 'Meta ads',
    body: "Each campaign, ad set and ad with Meta's spend next to the customers and revenue FounderData credits to it, plus the Conversions API.",
  },
  asa: {
    title: 'Apple Search Ads',
    body: 'Spend, installs, trials, paid conversions and ROAS per campaign and keyword, next to your App Store revenue.',
  },
  subscriptions: {
    title: 'Subscriptions',
    body: 'MRR and its movement, trials, churn, LTV and a retention grid per signup month, split by source, plan and provider.',
    collected: 'Core already stores the subscriptions your payment providers send, so the reports show your history the day you switch.',
  },
  appstore: {
    title: 'App Store',
    body: 'Daily App Store sales and proceeds per product and country, imported from App Store Connect.',
  },
};

/** The Connected apps page (/apps), the Pro card's text for it. */
export const PRO_APPS_PAGE = {
  title: 'Connected apps',
  body: 'Every iOS app on one page: sessions, onboarding completion, paywall conversion, purchases and revenue, side by side.',
  collected: 'Core already stores the events FounderDataKit sends, so the page shows your history the day you switch.',
};

/** Everything Pro adds, for the Pro card in Settings. */
export const PRO_LIST = [
  'MRR, churn, LTV and retention per source, for every subscription provider',
  'iOS app analytics, App Store sales, Apple Search Ads, ASO, and the iPhone app with widgets and a push for every payment',
  'Meta ads with the Conversions API, spend from every other channel, MER and CAC',
  'Search Console, Google rank tracking and a page audit',
  'AI visibility in ChatGPT, Claude, Gemini and Perplexity',
  'Home across all your sites with next actions, and a verdict on every change you log',
  'All 30 MCP tools, the query tool, alert rules and agent skills',
  'Teammates with their own login',
];
