import { AppError } from '../../shared/contracts';
import { finiteJson, jsonText, type Json } from '../../shared/json';

export function schemaAccepted(schema: unknown, depth = 0): schema is { [key: string]: Json } {
  if (depth > 20 || !schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const s = schema as Record<string, unknown>;
  const keys = new Set([
    '$schema',
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'anyOf',
    'description',
    'title',
    'default',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'pattern',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
  ]);
  if (Object.keys(s).some((key) => !keys.has(key))) return false;
  if (
    'required' in s &&
    (!Array.isArray(s.required) || !s.required.every((v) => typeof v === 'string'))
  )
    return false;
  if (
    'additionalProperties' in s &&
    typeof s.additionalProperties !== 'boolean' &&
    (typeof s.additionalProperties !== 'object' || s.additionalProperties === null)
  )
    return false;
  if (
    'properties' in s &&
    (s.properties === null || typeof s.properties !== 'object' || Array.isArray(s.properties))
  )
    return false;
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'])
    if (
      key in s &&
      (typeof s[key] !== 'number' ||
        !Number.isFinite(s[key]) ||
        (key === 'multipleOf' && (s[key] as number) <= 0))
    )
      return false;
  for (const key of [
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
  ])
    if (key in s && (!Number.isSafeInteger(s[key]) || (s[key] as number) < 0)) return false;
  if ('pattern' in s) {
    if (typeof s.pattern !== 'string' || s.pattern.length > 4096) return false;
    try {
      new RegExp(s.pattern);
    } catch {
      return false;
    }
  }
  for (const key of ['title', 'description'])
    if (key in s && typeof s[key] !== 'string') return false;
  if ('enum' in s && (!Array.isArray(s.enum) || !s.enum.length)) return false;
  if (
    s.type !== undefined &&
    !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(
      s.type as string,
    )
  )
    return false;
  if ('$schema' in s && typeof s.$schema !== 'string') return false;
  // The empty schema accepts any JSON value (including additionalProperties: {}).
  if (!Object.keys(s).length) return true;
  if (!s.type && !s.anyOf && !s.enum && !('const' in s)) return false;
  if (s.anyOf && (!Array.isArray(s.anyOf) || !s.anyOf.every((v) => schemaAccepted(v, depth + 1))))
    return false;
  if (
    s.properties &&
    (typeof s.properties !== 'object' ||
      Array.isArray(s.properties) ||
      !Object.values(s.properties).every((v) => schemaAccepted(v, depth + 1)))
  )
    return false;
  if (s.items && !schemaAccepted(s.items, depth + 1)) return false;
  if (
    typeof s.additionalProperties === 'object' &&
    !schemaAccepted(s.additionalProperties, depth + 1)
  )
    return false;
  return true;
}
export function convertResult(raw: unknown) {
  finiteJson(raw);
  const value = raw as Record<string, Json>;
  jsonText(value); // UTF-8 size, finite values, 1 MiB ceiling.
  const blocks = value.content;
  if (
    !Array.isArray(blocks) ||
    blocks.some(
      (block) =>
        !block ||
        typeof block !== 'object' ||
        Array.isArray(block) ||
        block.type !== 'text' ||
        typeof block.text !== 'string',
    )
  )
    throw new AppError(503, 'mcp_unsupported_content');
  return {
    isError: value.isError === true,
    output: [
      ...blocks.map((block) => ({
        type: 'text' as const,
        text: (block as Record<string, Json>).text as string,
      })),
      ...('structuredContent' in value
        ? [{ type: 'text' as const, text: JSON.stringify(value.structuredContent) }]
        : []),
    ],
  };
}
