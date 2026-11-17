import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/** True when the person asked the system for less motion. Read it before starting a JavaScript animation. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** The motion tokens of styles.css, for the Web Animations API. */
export const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
export const EASE_SPRING = 'cubic-bezier(0.34, 1.36, 0.64, 1)';
export const DUR = { fast: 120, base: 180, slow: 240, slower: 320 } as const;

/**
 * Slides a `.fd-thumb` chip under the active child of a container: the tab with `.tab-active` or the button with
 * aria-pressed="true". The container gets `data-indicator` (tabs) or `data-thumb` (segmented), which hides the
 * active child's own chip so only the sliding one shows. The first placement does not animate.
 */
export function useIndicator(container: RefObject<HTMLElement>, thumb: RefObject<HTMLElement>, selector: string, key: unknown) {
  useLayoutEffect(() => {
    const box = container.current;
    const t = thumb.current;
    if (!box || !t) return;
    let first = !t.dataset.placed;
    const place = () => {
      const el = box.querySelector<HTMLElement>(selector);
      if (!el) {
        t.style.opacity = '0';
        return;
      }
      const b = box.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (first) t.style.transition = 'none';
      t.style.opacity = '1';
      t.style.width = `${r.width}px`;
      t.style.height = `${r.height}px`;
      t.style.transform = `translate(${r.left - b.left - box.clientLeft + box.scrollLeft}px, ${r.top - b.top - box.clientTop}px)`;
      if (first) {
        void t.offsetWidth;
        t.style.transition = '';
        first = false;
        t.dataset.placed = '1';
      }
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(box);
    for (const c of Array.from(box.children)) ro.observe(c);
    const mo = new MutationObserver(place);
    mo.observe(box, { subtree: true, attributes: true, attributeFilter: ['class', 'aria-pressed'] });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [container, thumb, selector, key]);
}
