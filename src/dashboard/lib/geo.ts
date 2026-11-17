import { COUNTRY_POINTS } from './geo-countries';
import { LAND_MASK } from './geo-land';

/**
 * Geography for the live globe and its flat fallback: where a visitor goes on the map, and where the land is.
 * Everything here is static data in the bundle; nothing is fetched.
 */

export type LatLon = [lat: number, lon: number];

let countries: Map<string, LatLon> | null = null;

/** The label point of a country (ISO 3166-1 alpha-2), or null for an unknown code. */
export function countryPoint(cc: string | null | undefined): LatLon | null {
  if (!cc || cc.length !== 2) return null;
  if (!countries) {
    countries = new Map();
    for (const entry of COUNTRY_POINTS.trim().split(' ')) {
      const [lat, lon] = entry.slice(2).split(',').map(Number);
      countries.set(entry.slice(0, 2), [lat, lon]);
    }
  }
  return countries.get(cc.toUpperCase()) ?? null;
}

/** A 32-bit FNV-1a hash, so one visitor id always gets the same offset. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Coordinates are kept to one decimal (about 11 km), never finer. */
export const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Where a visitor or a place goes on the globe. Its own coordinates when it has them; otherwise its country's label
 * point moved by up to `spread` degrees in a direction taken from the id, so people in one country do not stack on
 * one pixel. Null when neither is known: that visitor stays in the list and off the map.
 */
export function placePoint(
  p: { id?: string; lat?: number | null; lon?: number | null; country?: string | null },
  spread = 1.1,
): LatLon | null {
  if (p.lat != null && p.lon != null && Number.isFinite(p.lat) && Number.isFinite(p.lon)) return [round1(p.lat), round1(p.lon)];
  const c = countryPoint(p.country);
  if (!c) return null;
  if (!p.id) return c;
  const h = hashId(p.id);
  const angle = ((h & 0xffff) / 0x10000) * Math.PI * 2;
  // sqrt spreads the points evenly over the disc instead of bunching them at its centre.
  const r = Math.sqrt((h >>> 16) / 0x10000) * spread;
  const lat = Math.max(-85, Math.min(85, c[0] + Math.sin(angle) * r));
  const lon = c[1] + (Math.cos(angle) * r) / Math.max(0.3, Math.cos((c[0] * Math.PI) / 180));
  return [lat, ((lon + 540) % 360) - 180];
}

const MASK_W = 720;
const MASK_H = 360;
let mask: Uint8Array | null = null;

function landMask(): Uint8Array {
  if (mask) return mask;
  mask = new Uint8Array(MASK_W * MASK_H);
  const rows = LAND_MASK.split(',');
  for (let r = 0; r < MASK_H; r++) {
    const row = rows[r];
    if (!row) continue;
    let c = 0;
    let land = false;
    for (const run of row.split('.')) {
      const n = parseInt(run, 36);
      if (land) mask.fill(1, r * MASK_W + c, r * MASK_W + c + n);
      c += n;
      land = !land;
    }
  }
  return mask;
}

/** True when the 0.5 degree cell around this point is land (Natural Earth 1:50m). */
export function isLand(lat: number, lon: number): boolean {
  const r = Math.min(MASK_H - 1, Math.max(0, Math.floor((90 - lat) * 2)));
  const c = (((Math.floor((lon + 180) * 2) % MASK_W) + MASK_W) % MASK_W);
  return landMask()[r * MASK_W + c] === 1;
}

/**
 * Dots over land, in rows of equal latitude: `step` degrees apart along each row and between rows, with fewer dots
 * per row toward the poles so the spacing on the sphere stays even. Rows stop at 75S, which hides most of
 * Antarctica's ice edge. Returned flat: lat, lon, lat, lon, ...
 */
export function landDots(step: number): Float32Array {
  const out: number[] = [];
  for (let lat = 84 - step / 2; lat > -75; lat -= step) {
    const n = Math.max(1, Math.round((360 * Math.cos((lat * Math.PI) / 180)) / step));
    const offset = (Math.round(lat / step) % 2) * 0.5; // alternate rows sit half a step over, like a honeycomb
    for (let i = 0; i < n; i++) {
      const lon = -180 + ((i + offset) * 360) / n;
      if (isLand(lat, lon)) out.push(lat, lon);
    }
  }
  return new Float32Array(out);
}

/** A unit vector for a point: x to the right, y up, z toward the viewer at longitude 0. */
export function toVector(lat: number, lon: number): [number, number, number] {
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
}
