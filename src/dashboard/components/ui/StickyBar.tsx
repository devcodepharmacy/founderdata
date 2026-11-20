import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A page header that stays at the top while the page scrolls. It spans the whole window with fixed side padding, so it
 * keeps the same width on every page whatever the page's own max width is. Its translucent backing spans it too, and a
 * hairline under it appears once the page has scrolled, so at rest it looks like part of the page. `from="sm"` keeps
 * it in the flow on phones, where a wrapped header would take too much of the screen.
 */
export function StickyBar({ children, className = '', from = 'sm' }: { children: ReactNode; className?: string; from?: 'all' | 'sm' }) {
  const [stuck, setStuck] = useState(false);
  const raf = useRef(0);
  useEffect(() => {
    const on = () => {
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => setStuck(window.scrollY > 4));
    };
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => {
      cancelAnimationFrame(raf.current);
      window.removeEventListener('scroll', on);
    };
  }, []);
  const sticky = from === 'sm' ? 'sm:sticky' : 'sticky';
  return (
    <header data-stuck={stuck || undefined} className={`group/bar relative top-0 z-40 -mt-3 mx-[calc(50%-50vw)] px-4 py-3 sm:px-6 lg:px-8 ${sticky} ${className}`}>
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 hidden border-b border-transparent bg-paper/75 opacity-0 backdrop-blur-xl backdrop-saturate-150 transition-[opacity,border-color] duration-base group-data-[stuck]/bar:border-stone-200/80 group-data-[stuck]/bar:opacity-100 ${from === 'sm' ? 'sm:block' : 'block'}`}
      />
      <div className="relative">{children}</div>
    </header>
  );
}
