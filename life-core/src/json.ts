/** PostgreSQL JSONB rejects NUL and unpaired surrogates even inside JSON strings. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'string') return value.toWellFormed().replaceAll('\0', '\uFFFD');
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [String(jsonSafe(k)), jsonSafe(v)]));
  return value;
}
