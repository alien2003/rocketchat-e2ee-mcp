/**
 * Minimal EJSON reader. The Rocket.Chat client serialises message content with Meteor's `EJSON.stringify`
 * before encrypting it, so `Date`s arrive as `{"$date": <ms>}` and binary as `{"$binary": "<base64>"}`.
 * We only read EJSON, never write it, and map the extended types to plain JSON values:
 *   $date -> ISO-8601 string, $binary -> base64 string, $InfNaN -> number, $regexp -> "/src/flags",
 *   $escape -> the escaped object verbatim, $type/$value (custom types) -> kept as-is.
 */
export function parseEjson(text: string): unknown {
  return revive(JSON.parse(text));
}

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value === null || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    if ('$date' in obj && typeof obj.$date === 'number') return new Date(obj.$date).toISOString();
    if ('$binary' in obj && typeof obj.$binary === 'string') return obj.$binary;
    if ('$InfNaN' in obj && typeof obj.$InfNaN === 'number') {
      return obj.$InfNaN === 0 ? Number.NaN : obj.$InfNaN > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    }
    if ('$escape' in obj && obj.$escape && typeof obj.$escape === 'object') {
      const raw = obj.$escape as Record<string, unknown>;
      return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, revive(v)]));
    }
  }
  if (keys.length === 2 && '$regexp' in obj && '$flags' in obj) return `/${String(obj.$regexp)}/${String(obj.$flags)}`;
  if (keys.length === 2 && '$type' in obj && '$value' in obj) return obj;
  return Object.fromEntries(keys.map((k) => [k, revive(obj[k])]));
}
