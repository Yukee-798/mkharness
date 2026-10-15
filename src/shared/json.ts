export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const JSON_MAX_BYTES = 1048576;
const encoder = new TextEncoder();
export function finiteJson(value: unknown): asserts value is Json {
  const seen = new Set<unknown>();
  function visit(v: unknown): void {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || seen.has(v)) throw new Error('Expected finite JSON');
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      throw new Error('Expected plain JSON');
    seen.add(v);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(v))) {
      if (descriptor.get || descriptor.set) throw new Error('Accessors are not JSON');
      visit(descriptor.value);
    }
    seen.delete(v);
  }
  visit(value);
}
export function jsonText(value: unknown, limit: number = JSON_MAX_BYTES): string {
  finiteJson(value);
  const text = JSON.stringify(value);
  if (encoder.encode(text).length > limit) throw new Error('JSON size limit exceeded');
  return text;
}
// Object insertion order is not part of JSON's value semantics. Keep arrays ordered,
// and emit valid JSON so durable request records can still be decoded on recovery.
export function canonicalJson(value: unknown): string {
  finiteJson(value);
  jsonText(value);
  const encode = (v: Json): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(encode).join(',') + ']';
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + encode(v[key]!))
        .join(',') +
      '}'
    );
  };
  return encode(value);
}
export const jsonEqual = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);
