import { useEffect, useMemo, useRef, useState } from 'react';
import { isLand as isLandCell, landDots, placePoint, toVector, type LatLon } from '../../lib/geo';
import { GlobeGL, Kind, STRIDE, rotate, type GlobeColors } from './globe-gl';
import { eventAmount, placeLabel, prefersReducedMotion, pageLabel } from './shared';
import type { LiveEvent, LivePlace, LiveVisitor } from './types';

/**
 * The live globe, loaded as its own chunk (Globe.tsx wraps it in React.lazy). WebGL when the browser has it, a flat
 * SVG dot map when it does not or when the context is lost. Everything it draws comes from its props and from the
 * static geography in lib/geo.ts: no tiles, no textures, no requests.
 */

export interface GlobeProps {
  visitors: LiveVisitor[];
  places?: LivePlace[];
  events?: LiveEvent[];
  /** A visitor id or an event key to light up, from a hovered list row. */
  highlightId?: string | null;
  /** Called with the visitor id or event key under the pointer, or null. */
  onHover?: (id: string | null) => void;
  /** Drag to spin and hover markers. Off for the Home card, where a click opens the live page. */
  interactive?: boolean;
  /** Turn toward each new payment. */
  followPayments?: boolean;
  /** Show the amount over new payments and a label over the hovered marker. */
  labels?: boolean;
  /** The sphere's radius as a share of half the shorter side. */
  fill?: number;
  className?: string;
}

type Rgb = [number, number, number];

interface Theme {
  dark: boolean;
  accent: Rgb;
  money: Rgb;
  ink: Rgb;
  land: Rgb;
  landAlpha: number;
  colors: GlobeColors;
}

function triple(cs: CSSStyleDeclaration, name: string, fallback: Rgb): Rgb {
  const parts = cs.getPropertyValue(name).trim().split(/[\s,]+/).map(Number);
  return parts.length >= 3 && parts.every((n) => Number.isFinite(n)) ? [parts[0] / 255, parts[1] / 255, parts[2] / 255] : fallback;
}

function readTheme(): Theme {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const dark = root.classList.contains('dark');
  const brand = triple(cs, '--brand', [46 / 255, 230 / 255, 166 / 255]);
  const money = triple(cs, '--revenue', [224 / 255, 89 / 255, 58 / 255]);
  const ink = triple(cs, '--ink', dark ? [0.95, 0.95, 0.94] : [0.08, 0.08, 0.07]);
  if (dark) {
    return {
      dark,
      accent: brand,
      money,
      ink,
      land: [0.8, 0.83, 0.88],
      landAlpha: 0.78,
      colors: {
        sphereCenter: [0.105, 0.11, 0.125],
        sphereEdge: [0.03, 0.033, 0.04],
        rim: [brand[0] * 0.2 + 0.03, brand[1] * 0.2 + 0.03, brand[2] * 0.2 + 0.035],
        halo: brand,
        haloAlpha: 0.26,
      },
    };
  }
  // On white the bright mint reads as a smudge, so markers lean toward --brand-text, the mint that passes AA on white.
  const text = triple(cs, '--brand-text', [10 / 255, 122 / 255, 86 / 255]);
  const deep: Rgb = [brand[0] * 0.45 + text[0] * 0.55, brand[1] * 0.45 + text[1] * 0.55, brand[2] * 0.45 + text[2] * 0.55];
  return {
    dark,
    accent: deep,
    money,
    ink,
    land: [0.33, 0.35, 0.39],
    landAlpha: 0.66,
    colors: {
      sphereCenter: [1, 1, 1],
      sphereEdge: [0.865, 0.875, 0.89],
      rim: [0.02, 0.02, 0.025],
      halo: brand,
      haloAlpha: 0.1,
    },
  };
}

function useTheme(): Theme {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(readTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const rad = (d: number) => (d * Math.PI) / 180;

const AUTO_SPEED = 0.055; // radians a second: one turn in about two minutes
const TILT = 0.38; // the resting tilt shows the northern hemisphere, where most traffic is
const PULSE_MS = 1600;

interface Marker {
  id: string;
  v: [number, number, number];
  born: number;
  died: number | null;
  phase: number;
  customer: boolean;
}

interface Pay {
  key: string;
  v: [number, number, number];
  ts: number;
  seen: number;
  animate: boolean;
  kind: LiveEvent['kind'];
}

interface PayLabel {
  key: string;
  text: string;
  place: string;
  money: boolean;
}

export default function GlobeView(props: GlobeProps) {
  const [flat, setFlat] = useState(false);
  if (flat) return <FlatMap {...props} />;
  return <WebGLGlobe {...props} onFail={() => setFlat(true)} />;
}

function WebGLGlobe(props: GlobeProps & { onFail: () => void }) {
  const { visitors, places = [], events = [], highlightId = null, interactive = true, followPayments = true, labels = true, fill = 0.8, className = '' } = props;
  const theme = useTheme();
  const wrap = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const hoverLabel = useRef<HTMLDivElement>(null);
  const labelEls = useRef(new Map<string, HTMLDivElement>());
  const [payLabels, setPayLabels] = useState<PayLabel[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // Everything the animation loop reads lives in one mutable object, so a frame never waits on React.
  const s = useRef({
    gl: null as GlobeGL | null,
    phi: rad(-12),
    theta: TILT,
    vphi: AUTO_SPEED,
    dragging: false,
    moved: 0,
    lastX: 0,
    lastY: 0,
    lastT: 0,
    releasedAt: -1e9,
    focus: null as null | { p0: number; t0: number; p1: number; t1: number; start: number; dur: number },
    pending: null as null | { lat: number; lon: number; at: number },
    holdUntil: 0,
    markers: new Map<string, Marker>(),
    pays: new Map<string, Pay>(),
    places: [] as { v: [number, number, number]; w: number }[],
    highlight: null as string | null,
    hover: null as string | null,
    theme,
    fill,
    reduced: prefersReducedMotion(),
    visible: true,
    raf: 0,
    last: 0,
    landStep: 0,
    landDark: null as boolean | null,
    dyn: new Float32Array(STRIDE * 512),
    mounted: performance.now(),
    centred: false,
    draw: () => {},
  }).current;
  s.theme = theme;
  s.fill = fill;
  s.highlight = highlightId ?? hovered;

  // Visitors: keep each marker across polls so it can pulse in and fade out.
  useEffect(() => {
    const now = performance.now();
    const seen = new Set<string>();
    let i = 0;
    const first = s.markers.size === 0;
    for (const v of visitors) {
      const at = placePoint(v);
      if (!at) continue;
      seen.add(v.id);
      const m = s.markers.get(v.id);
      if (m) {
        m.v = toVector(at[0], at[1]);
        m.customer = v.customer;
        m.died = null;
      } else {
        // The first batch comes in as a quick cascade instead of all at once.
        s.markers.set(v.id, { id: v.id, v: toVector(at[0], at[1]), born: now + (first ? i++ * 45 : 0), died: null, phase: Math.random() * 6.28, customer: v.customer });
      }
    }
    for (const m of s.markers.values()) if (!seen.has(m.id) && m.died === null) m.died = now;
    // Face the crowd the first time there is one: the circular mean of their longitudes.
    if (!s.centred && seen.size) {
      let x = 0, z = 0;
      for (const id of seen) {
        const m = s.markers.get(id)!;
        x += m.v[0];
        z += m.v[2];
      }
      s.phi = -Math.atan2(x, z) + 0.25;
      s.centred = true;
    }
    s.draw();
  }, [visitors, s]);

  useEffect(() => {
    let max = 1;
    for (const p of places) max = Math.max(max, p.visitors);
    s.places = [];
    for (const p of places) {
      const at = placePoint({ ...p, id: p.key }, 0.6);
      if (at) s.places.push({ v: toVector(at[0], at[1]), w: Math.sqrt(p.visitors / max) });
    }
    // With nobody online, face the busiest places of the window instead.
    if (!s.centred && s.places.length && s.markers.size === 0) {
      let x = 0, z = 0;
      for (const p of s.places) {
        x += p.v[0] * p.w;
        z += p.v[2] * p.w;
      }
      s.phi = -Math.atan2(x, z) + 0.25;
    }
    s.draw();
  }, [places, s]);

  // Events: a payment or signup that arrives while the globe is open gets its moment; older ones stay as dots.
  useEffect(() => {
    const now = performance.now();
    const wall = Date.now();
    const fresh: { e: LiveEvent; at: LatLon }[] = [];
    const keep = new Set<string>();
    for (const e of events) {
      const at = placePoint({ id: e.key, lat: e.lat, lon: e.lon, country: e.country }, 0.6);
      if (!at) continue;
      keep.add(e.key);
      if (s.pays.has(e.key)) continue;
      const animate = now - s.mounted > 1500 || wall - e.ts < 20_000;
      s.pays.set(e.key, { key: e.key, v: toVector(at[0], at[1]), ts: e.ts, seen: now, animate, kind: e.kind });
      if (animate) fresh.push({ e, at });
    }
    for (const k of s.pays.keys()) if (!keep.has(k)) s.pays.delete(k);
    const money = fresh.filter((f) => f.e.kind === 'payment').sort((a, b) => b.e.ts - a.e.ts);
    // The turn waits while someone holds or just let go of the globe; step() starts it once they are done.
    if (money.length && followPayments && !s.reduced) s.pending = { lat: money[0].at[0], lon: money[0].at[1], at: now };
    if (labels && fresh.length) {
      const add: PayLabel[] = fresh
        .filter((f) => f.e.kind === 'payment' || f.e.kind === 'trial')
        .slice(0, 2)
        .map(({ e }) => ({
          key: e.key,
          text: e.kind === 'payment' ? eventAmount(e) ?? 'Payment' : 'Trial',
          place: e.city ?? placeLabel(e),
          money: e.kind === 'payment',
        }));
      if (add.length) {
        setPayLabels((cur) => [...add, ...cur.filter((c) => !add.some((a) => a.key === c.key))].slice(0, 3));
        const keys = add.map((a) => a.key);
        setTimeout(() => setPayLabels((cur) => cur.filter((c) => !keys.includes(c.key))), 7000);
      }
    }
    s.draw();
  }, [events, followPayments, labels, s]);

  // The WebGL setup, the frame loop and the pause rules.
  useEffect(() => {
    const box = wrap.current!;
    // A new canvas per mount: StrictMode runs this effect twice in development, and a canvas whose context was
    // released by the first cleanup cannot give a working one back.
    const el = document.createElement('canvas');
    el.className = 'absolute inset-0 block h-full w-full';
    el.setAttribute('aria-hidden', 'true');
    canvasHost.current!.appendChild(el);
    const setCursor = () => {
      const on = propsRef.current.interactive !== false;
      el.style.cursor = on ? (s.dragging ? 'grabbing' : 'grab') : '';
      el.style.touchAction = on ? 'pan-y' : 'auto';
    };
    setCursor();
    let gl: GlobeGL;
    try {
      gl = new GlobeGL(el);
    } catch (err) {
      console.warn('Live globe: no WebGL, showing the flat map instead.', err);
      el.remove();
      props.onFail();
      return;
    }
    s.gl = gl;
    const onLost = (e: Event) => {
      e.preventDefault();
      props.onFail();
    };
    el.addEventListener('webglcontextlost', onLost);

    const size = () => {
      const r = box.getBoundingClientRect();
      gl.resize(r.width, r.height, window.devicePixelRatio || 1);
      draw();
    };

    function buildLand() {
      const R = (Math.min(gl.width, gl.height) / 2) * s.fill;
      const step = R >= 380 ? 0.9 : R >= 250 ? 1.15 : R >= 160 ? 1.45 : 1.8;
      if (step === s.landStep && s.landDark === s.theme.dark) return;
      s.landStep = step;
      s.landDark = s.theme.dark;
      const ll = landDots(step);
      const data = new Float32Array((ll.length / 2) * STRIDE);
      const dot = Math.max(1.3, rad(step) * R * 0.56);
      const [r, g, b] = s.theme.land;
      for (let i = 0, j = 0; i < ll.length; i += 2, j += STRIDE) {
        const v = toVector(ll[i], ll[i + 1]);
        data.set([v[0], v[1], v[2], dot, r, g, b, s.theme.landAlpha, Kind.Land], j);
      }
      gl.setLand(data);
    }

    function step(now: number) {
      const dt = Math.min(0.05, (now - (s.last || now)) / 1000);
      s.last = now;
      if (s.dragging) return;
      if (s.pending && !s.focus && now - s.releasedAt > 1500) {
        // A payment older than 10 s has had its moment; turning to it late would look like a glitch.
        if (now - s.pending.at < 10_000) {
          const p1 = s.phi + wrapPi(-rad(s.pending.lon) - s.phi);
          s.focus = { p0: s.phi, t0: s.theta, p1, t1: clamp(rad(s.pending.lat) * 0.8, -0.3, 0.75), start: now, dur: 1800 };
        }
        s.pending = null;
      }
      if (s.focus) {
        const k = clamp((now - s.focus.start) / s.focus.dur, 0, 1);
        const e = easeInOut(k);
        s.phi = s.focus.p0 + (s.focus.p1 - s.focus.p0) * e;
        s.theta = s.focus.t0 + (s.focus.t1 - s.focus.t0) * e;
        if (k === 1) {
          s.focus = null;
          s.holdUntil = now + 3500;
          s.vphi = 0;
        }
        return;
      }
      const target = s.reduced || now < s.holdUntil ? 0 : AUTO_SPEED;
      s.vphi += (target - s.vphi) * (1 - Math.exp(-dt * 2.2));
      s.phi += s.vphi * dt;
      if (now - s.releasedAt > 1200 && now > s.holdUntil) s.theta += (TILT - s.theta) * (1 - Math.exp(-dt * 0.5));
    }

    function push(o: number, v: readonly number[], alt: number, size: number, c: readonly number[], a: number, kind: number) {
      if (o + STRIDE > s.dyn.length) {
        const bigger = new Float32Array(s.dyn.length * 2);
        bigger.set(s.dyn);
        s.dyn = bigger;
      }
      const d = s.dyn;
      d[o] = v[0] * alt;
      d[o + 1] = v[1] * alt;
      d[o + 2] = v[2] * alt;
      d[o + 3] = Math.min(size, gl.maxPointSize / gl.dpr);
      d[o + 4] = c[0];
      d[o + 5] = c[1];
      d[o + 6] = c[2];
      d[o + 7] = a;
      d[o + 8] = kind;
      return o + STRIDE;
    }

    function render(now: number) {
      buildLand();
      const t = s.theme;
      const R = (Math.min(gl.width, gl.height) / 2) * s.fill;
      const k = clamp(R / 190, 0.7, 1.7);
      const still = s.reduced;
      let o = 0;
      // Places, when the caller passes them (the live page's 30 min, 1 h or 24 h window): a soft glow under a small dot,
      // dimmer than an online visitor. Without places the globe glows only where people are online now.
      for (const p of s.places) {
        o = push(o, p.v, 1.0, (9 + 16 * p.w) * k, t.accent, (t.dark ? 0.22 : 0.16) + 0.18 * p.w, Kind.Place);
        o = push(o, p.v, 1.0, (3 + 2.5 * p.w) * k, t.accent, t.dark ? 0.75 : 0.7, Kind.Land);
      }

      // Payment and signup rings under the markers, so the markers stay readable.
      for (const p of s.pays.values()) {
        if (!p.animate || still) continue;
        const age = now - p.seen;
        const c = p.kind === 'payment' ? t.money : t.accent;
        const rings = p.kind === 'payment' ? [0, 500, 1000] : [0];
        const reach = p.kind === 'payment' ? 120 : 50;
        for (const off of rings) {
          const tt = (age - off) / 2000;
          if (tt <= 0 || tt >= 1) continue;
          o = push(o, p.v, 1.0, (10 + reach * easeOut(tt)) * k, c, (1 - tt) ** 1.4, Kind.Ring);
        }
      }

      for (const m of s.markers.values()) {
        const age = now - m.born;
        if (age < 0) continue;
        const fade = m.died === null ? 1 : 1 - (now - m.died) / 900;
        if (fade <= 0) {
          s.markers.delete(m.id);
          continue;
        }
        if (!still && age < PULSE_MS) {
          const tt = age / PULSE_MS;
          o = push(o, m.v, 1.0, (8 + 46 * easeOut(tt)) * k, t.accent, 0.85 * (1 - tt) ** 1.6, Kind.Ring);
        }
        const appear = still ? 1 : easeOut(clamp(age / 450, 0, 1));
        const breathe = still ? 1 : 1 + 0.07 * Math.sin(now / 650 + m.phase);
        const lit = s.highlight === m.id;
        const size = (m.customer ? 27 : 23) * k * appear * breathe * (lit ? 1.55 : 1);
        o = push(o, m.v, 1.012, size, t.accent, fade, Kind.Glow);
        if (lit) o = push(o, m.v, 1.0, 30 * k, t.ink, 0.9, Kind.Ring);
      }

      for (const p of s.pays.values()) {
        const age = now - p.seen;
        const hourLeft = clamp(1 - (Date.now() - p.ts) / 3_600_000, 0, 1);
        const money = p.kind === 'payment';
        const lit = s.highlight === p.key;
        const big = p.animate && !still && age < 6000 ? 1 + 0.9 * (1 - easeOut(age / 6000)) : 1;
        const size = (money ? 19 : 13) * k * big * (lit ? 1.5 : 1);
        o = push(o, p.v, 1.014, size, money ? t.money : t.accent, (money ? 0.55 : 0.35) + 0.45 * hourLeft, Kind.Glow);
        if (lit) o = push(o, p.v, 1.0, 30 * k, t.ink, 0.9, Kind.Ring);
      }

      gl.draw(s.phi, s.theta, s.fill, t.colors, s.dyn, o / STRIDE);
      placeLabels();
    }

    function project(v: readonly number[]) {
      const side = Math.min(gl.width, gl.height);
      const R = (side / 2) * s.fill;
      const p = rotate(v, s.phi, s.theta);
      return { x: gl.width / 2 + p[0] * R, y: gl.height / 2 - p[1] * R, front: p[2] > 0.08 };
    }

    function placeLabels() {
      for (const [key, node] of labelEls.current) {
        const p = s.pays.get(key);
        if (!p) continue;
        const at = project(p.v);
        node.style.transform = `translate(${at.x.toFixed(1)}px, ${(at.y - 10).toFixed(1)}px)`;
        node.style.opacity = at.front ? '1' : '0';
      }
      const hl = hoverLabel.current;
      if (hl) {
        const id = s.hover;
        const m = id ? s.markers.get(id)?.v ?? s.pays.get(id)?.v : null;
        if (m) {
          const at = project(m);
          hl.style.transform = `translate(${at.x.toFixed(1)}px, ${(at.y - 14).toFixed(1)}px)`;
          hl.style.opacity = at.front ? '1' : '0';
        } else hl.style.opacity = '0';
      }
    }

    function loop(now: number) {
      s.raf = 0;
      if (!s.visible || document.hidden || gl.lost) return;
      step(now);
      render(now);
      if (!s.reduced) s.raf = requestAnimationFrame(loop);
    }

    // One frame now. With motion on, this also restarts the loop after a pause.
    function draw() {
      if (s.raf) return;
      s.last = 0;
      s.raf = requestAnimationFrame(loop);
    }
    s.draw = draw;

    // Hover and drag.
    const pick = (x: number, y: number) => {
      let best: string | null = null;
      let bestD = 16 * 16;
      const test = (id: string, v: readonly number[]) => {
        const p = project(v);
        if (!p.front) return;
        const d = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      };
      for (const m of s.markers.values()) if (m.died === null) test(m.id, m.v);
      for (const p of s.pays.values()) test(p.key, p.v);
      return best;
    };
    const setHover = (id: string | null) => {
      if (s.hover === id) return;
      s.hover = id;
      setHovered(id);
      propsRef.current.onHover?.(id);
      draw();
    };
    const local = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const down = (e: PointerEvent) => {
      if (propsRef.current.interactive === false || e.button !== 0) return;
      s.dragging = true;
      s.moved = 0;
      s.focus = null;
      s.lastX = e.clientX;
      s.lastY = e.clientY;
      s.lastT = performance.now();
      s.vphi = 0;
      el.setPointerCapture(e.pointerId);
      setCursor();
    };
    const move = (e: PointerEvent) => {
      if (propsRef.current.interactive === false) return;
      if (s.dragging) {
        const now = performance.now();
        const R = (Math.min(gl.width, gl.height) / 2) * s.fill;
        const dx = e.clientX - s.lastX;
        const dy = e.clientY - s.lastY;
        s.moved += Math.abs(dx) + Math.abs(dy);
        const dphi = dx / R;
        s.phi += dphi;
        s.theta = clamp(s.theta + dy / R, -0.6, 1.1);
        const dt = Math.max(1, now - s.lastT) / 1000;
        s.vphi = s.vphi * 0.6 + (dphi / dt) * 0.4;
        s.lastX = e.clientX;
        s.lastY = e.clientY;
        s.lastT = now;
        if (s.reduced) draw();
        return;
      }
      if (e.pointerType === 'mouse') {
        const [x, y] = local(e);
        setHover(pick(x, y));
      }
    };
    const up = (e: PointerEvent) => {
      if (!s.dragging) return;
      s.dragging = false;
      s.releasedAt = performance.now();
      setCursor();
      // A flick keeps spinning and slows back to the resting speed; a held stop does not.
      if (performance.now() - s.lastT > 80) s.vphi = 0;
      s.vphi = clamp(s.vphi, -2.2, 2.2);
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (s.moved < 4 && e.pointerType !== 'mouse') {
        const [x, y] = local(e);
        setHover(pick(x, y));
      }
      draw();
    };
    const leave = () => !s.dragging && setHover(null);
    const click = (e: MouseEvent) => {
      // A drag that ends over the globe is not a click on whatever holds it.
      if (s.moved > 4) {
        e.stopPropagation();
        e.preventDefault();
        s.moved = 0;
      }
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('click', click, true);

    const ro = new ResizeObserver(size);
    ro.observe(box);
    const io = new IntersectionObserver(([entry]) => {
      s.visible = entry.isIntersecting;
      if (s.visible) draw();
    });
    io.observe(box);
    const onVis = () => !document.hidden && draw();
    document.addEventListener('visibilitychange', onVis);
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMq = () => {
      s.reduced = mq.matches;
      draw();
    };
    mq.addEventListener?.('change', onMq);
    size();

    return () => {
      cancelAnimationFrame(s.raf);
      s.raf = 0;
      s.draw = () => {};
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      mq.removeEventListener?.('change', onMq);
      el.removeEventListener('webglcontextlost', onLost);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('click', click, true);
      gl.dispose();
      el.remove();
      s.gl = null;
    };
    // The loop reads props through `s` and propsRef; setting it up once is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme, highlight and fill changes need a frame even when the loop is paused (reduced motion).
  useEffect(() => s.draw(), [theme, highlightId, hovered, fill, s]);

  const hoverText = useMemo(() => {
    const id = highlightId ?? hovered;
    if (!labels || !id) return null;
    const v = visitors.find((x) => x.id === id);
    if (v) return { title: placeLabel(v), sub: pageLabel(v), money: false };
    const e = events.find((x) => x.key === id);
    if (e) return { title: placeLabel(e), sub: eventAmount(e) ?? (e.kind === 'trial' ? 'Started a trial' : e.kind === 'signup' ? 'Signed up' : e.label ?? ''), money: e.kind === 'payment' };
    return null;
  }, [highlightId, hovered, visitors, events, labels]);
  s.hover = highlightId ?? hovered;

  const online = visitors.length;
  return (
    <div ref={wrap} className={`relative h-full w-full select-none ${className}`}>
      {/* The canvas is created by the setup effect, so each mount gets a fresh WebGL context. */}
      <div ref={canvasHost} className="absolute inset-0" role="img" aria-label={online === 1 ? 'Globe with 1 visitor online' : `Globe with ${online} visitors online`} />
      <div className="pointer-events-none absolute inset-0 overflow-visible">
        {payLabels.map((l) => (
          <div
            key={l.key}
            ref={(n) => {
              if (n) labelEls.current.set(l.key, n);
              else labelEls.current.delete(l.key);
            }}
            className="absolute left-0 top-0 transition-opacity duration-300"
            style={{ opacity: 0 }}
          >
            <div className="fd-live-pop whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-semibold text-onFill shadow-pop" style={{ background: l.money ? 'rgb(var(--revenue))' : 'rgb(var(--brand, 46 230 166) / .95)', transform: 'translate(-50%, -100%)' }}>
              {l.text}
              <span className="ml-1.5 font-medium">{l.place}</span>
            </div>
          </div>
        ))}
        <div ref={hoverLabel} className="absolute left-0 top-0 transition-opacity duration-150" style={{ opacity: 0 }}>
          {hoverText && (
            <div className="pop whitespace-nowrap px-2.5 py-1.5 text-[12px] leading-tight" style={{ transform: 'translate(-50%, -100%)' }}>
              <div className="font-semibold text-ink">{hoverText.title}</div>
              {hoverText.sub && <div className={hoverText.money ? 'font-medium text-revenue' : 'text-stone-500'}>{hoverText.sub}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The fallback without WebGL: the same dots and markers on a flat equirectangular map, latitudes 78N to 58S. */
function FlatMap({ visitors, places = [], events = [], highlightId = null, onHover, className = '' }: GlobeProps) {
  const TOP = 78;
  const BOTTOM = -58;
  const H = TOP - BOTTOM;
  const land = useMemo(() => {
    let d = '';
    for (let lat = TOP - 1.25; lat > BOTTOM; lat -= 2.5) {
      for (let lon = -178.75; lon < 180; lon += 2.5) if (isLandCell(lat, lon)) d += `M${(lon + 180).toFixed(2)} ${(TOP - lat).toFixed(2)}h0`;
    }
    return d;
  }, []);
  const xy = (at: LatLon) => [at[1] + 180, TOP - at[0]] as const;
  let max = 1;
  for (const p of places) max = Math.max(max, p.visitors);
  return (
    <div className={`relative h-full w-full ${className}`}>
      <svg viewBox={`0 0 360 ${H}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Map with ${visitors.length} visitors online`}>
        <path d={land} stroke="rgb(var(--stone-400))" strokeOpacity={0.55} strokeWidth={1.25} strokeLinecap="round" fill="none" />
        {places.map((p) => {
          const at = placePoint({ ...p, id: p.key }, 0.6);
          if (!at) return null;
          const [x, y] = xy(at);
          return <circle key={p.key} cx={x} cy={y} r={0.9 + 1.4 * Math.sqrt(p.visitors / max)} fill="rgb(var(--brand, 46 230 166))" opacity={0.35} />;
        })}
        {events.map((e) => {
          const at = placePoint({ id: e.key, lat: e.lat, lon: e.lon, country: e.country }, 0.6);
          if (!at) return null;
          const [x, y] = xy(at);
          return <circle key={e.key} cx={x} cy={y} r={highlightId === e.key ? 3.2 : 2.2} fill={e.kind === 'payment' ? 'rgb(var(--revenue))' : 'rgb(var(--brand, 46 230 166))'} onMouseEnter={() => onHover?.(e.key)} onMouseLeave={() => onHover?.(null)} />;
        })}
        {visitors.map((v) => {
          const at = placePoint(v);
          if (!at) return null;
          const [x, y] = xy(at);
          const lit = highlightId === v.id;
          return (
            <g key={v.id} onMouseEnter={() => onHover?.(v.id)} onMouseLeave={() => onHover?.(null)}>
              <circle cx={x} cy={y} r={lit ? 5.5 : 4} fill="rgb(var(--brand, 46 230 166))" opacity={0.22} />
              <circle cx={x} cy={y} r={lit ? 2.6 : 1.8} fill="rgb(var(--brand, 46 230 166))" stroke={lit ? 'rgb(var(--ink))' : 'none'} strokeWidth={0.6} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
