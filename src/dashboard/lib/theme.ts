import { useEffect, useState } from 'react';

/**
 * Light or dark theme. "system" follows prefers-color-scheme; "light" and "dark" pin it. The choice lives in
 * localStorage under THEME_KEY, and an inline script in index.html applies the `dark` class before first paint, so
 * keep the key and the rule there in step with this file.
 */
export type ThemePref = 'system' | 'light' | 'dark';

export const THEME_KEY = 'founderdata-theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<(p: ThemePref) => void>();

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function swap(dark: boolean) {
  // Switch every color at once: without this, buttons with a hover transition fade over 150 ms after the page.
  const still = document.createElement('style');
  still.textContent = '*, *::before, *::after { transition: none !important; }';
  document.head.appendChild(still);
  document.documentElement.classList.toggle('dark', dark);
  void getComputedStyle(document.body).color;
  requestAnimationFrame(() => still.remove());
}

type ViewTransitionDoc = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };

/**
 * Applies the theme. A change the person makes crossfades the page in 240 ms through a view transition where the
 * browser has them; reduced motion, a hidden tab and older browsers switch at once.
 */
function apply(pref: ThemePref, animate = false) {
  const dark = pref === 'dark' || (pref === 'system' && media().matches);
  if (dark === document.documentElement.classList.contains('dark')) return;
  const doc = document as ViewTransitionDoc;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden;
  if (!animate || still || !doc.startViewTransition) return swap(dark);
  const root = document.documentElement;
  root.classList.add('fd-theme-vt');
  doc.startViewTransition(() => swap(dark)).finished.finally(() => root.classList.remove('fd-theme-vt'));
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    // Private mode without storage: the choice holds for this page only.
  }
  apply(pref, true);
  listeners.forEach((l) => l(pref));
}

// Follow the system while the choice is "system", including a switch made while the dashboard is open.
if (typeof window !== 'undefined') {
  media().addEventListener('change', () => themePref() === 'system' && apply('system', true));
}

export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(themePref);
  useEffect(() => {
    listeners.add(setPref);
    return () => void listeners.delete(setPref);
  }, []);
  return [pref, setThemePref];
}
