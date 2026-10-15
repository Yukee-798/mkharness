import type { Json } from '../../../shared/json';
import { JSON_MAX_BYTES } from '../../../shared/json';
export type Program = { code: string; data: Json };
export type ComputeResult =
  { ok: true; value: Json } | { ok: false; error: { kind: string; message: string } };
export const LIMITS = {
  code: 65536,
  json: JSON_MAX_BYTES,
  heap: 16777216,
  interrupts: 1024,
  timeout: 500,
} as const;
export const failure = (kind: string, message: string): ComputeResult => ({
  ok: false,
  error: { kind, message },
});
