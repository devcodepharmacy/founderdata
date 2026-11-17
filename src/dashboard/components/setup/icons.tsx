import type { ReactNode } from 'react';

/** 18 px line icons for the settings rail and the setup cards. */
const icon = (d: ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);

export const SetupIcons = {
  overview: icon(<path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z" />),
  site: icon(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5s1.1-6.1 3.5-8.5z" />
    </>,
  ),
  install: icon(<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />),
  payments: icon(
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="M3 10h18M7 15h3" />
    </>,
  ),
  appstore: icon(
    <>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
    </>,
  ),
  seo: icon(
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4-4" />
    </>,
  ),
  ads: icon(<path d="M4 10v4a1 1 0 0 0 1 1h2l5 4V5L7 9H5a1 1 0 0 0-1 1zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" />),
  agents: icon(
    <>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3v4M9 12.5v1M15 12.5v1M2 12v3M22 12v3" />
    </>,
  ),
  alerts: icon(<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" />),
  imports: icon(<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />),
  sharing: icon(
    <>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M2.5 19.5c.8-3.2 3.3-5 6.5-5s5.7 1.8 6.5 5M16 5.2a3.5 3.5 0 0 1 0 6.6M18.5 14.8c1.6.7 2.6 2.3 3 4.7" />
    </>,
  ),
  privacy: icon(<path d="M12 3 5 6v5.5c0 4.4 3 8 7 9.5 4-1.5 7-5.1 7-9.5V6z M9 12l2 2 4-4" />),
  danger: icon(<path d="M12 4 2.5 20h19zM12 10v4.5M12 17.5v.01" />),
  sparkle: icon(<path d="M12 3.5 13.8 9a2 2 0 0 0 1.2 1.2l5.5 1.8-5.5 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.2 15A2 2 0 0 0 9 13.8L3.5 12 9 10.2A2 2 0 0 0 10.2 9z" />),
  key: icon(
    <>
      <circle cx="8" cy="15" r="4.5" />
      <path d="m11.2 11.8 8.3-8.3M16.5 6.5l2.5 2.5M14 9l2 2" />
    </>,
  ),
  phone: icon(
    <>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
    </>,
  ),
  puzzle: icon(<path d="M10 4.5a2 2 0 1 1 4 0V6h3.5A1.5 1.5 0 0 1 19 7.5V11h-1.5a2 2 0 1 0 0 4H19v3.5a1.5 1.5 0 0 1-1.5 1.5H14v-1.5a2 2 0 1 0-4 0V20H6.5A1.5 1.5 0 0 1 5 18.5V15h1.5a2 2 0 1 0 0-4H5V7.5A1.5 1.5 0 0 1 6.5 6H10z" />),
  mail: icon(
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </>,
  ),
  link: icon(<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />),
  check: icon(<path d="m5 12.5 4.5 4.5L19 7.5" />),
  arrow: icon(<path d="M5 12h14M13 6l6 6-6 6" />),
};

export type SetupIconName = keyof typeof SetupIcons;
