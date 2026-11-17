// A small JSON Schema check for the MCP output schemas (src/worker/mcp.ts): type (one or a list, with integer and
// null), properties, required, items, enum and additionalProperties false. Enough for the schemas the server
// declares; anything else in a schema is ignored. Returns the problems, empty when the value fits.
type Schema = Record<string, any>;

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function fits(type: string, v: unknown): boolean {
  const t = typeOf(v);
  if (type === 'integer') return t === 'number' && Number.isInteger(v);
  return t === type;
}

export function validate(schema: Schema, value: unknown, at = '$'): string[] {
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => fits(t, value) || (t === 'number' && fits('integer', value)))) {
      return [`${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`];
    }
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  if (typeOf(value) === 'object') {
    const o = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in o)) errors.push(`${at}: missing ${k}`);
    for (const [k, sub] of Object.entries<Schema>(schema.properties ?? {})) {
      if (k in o) errors.push(...validate(sub, o[k], `${at}.${k}`));
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(o)) if (!(k in (schema.properties ?? {}))) errors.push(`${at}: unexpected ${k}`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((x, i) => errors.push(...validate(schema.items, x, `${at}[${i}]`)));
  return errors;
}
