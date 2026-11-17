// Goal props are stored as JSON text. Cutting the JSON string at a byte limit leaves invalid JSON, so trim the
// object instead: at most 20 keys, 40-char keys, 200-char values, and drop trailing keys until it fits.
export function propsJson(p: unknown, max = 1000): string | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(p).slice(0, 20)) {
    const key = k.slice(0, 40);
    if (typeof v === 'string') out[key] = v.slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'boolean') out[key] = v;
    else if (v != null) out[key] = String(JSON.stringify(v)).slice(0, 200);
  }
  const keys = Object.keys(out);
  let json = JSON.stringify(out);
  while (json.length > max && keys.length) {
    delete out[keys.pop()!];
    json = JSON.stringify(out);
  }
  return keys.length ? json : null;
}
