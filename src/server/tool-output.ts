import { JSON_MAX_BYTES } from '../shared/json';

// These tools already validate their serialized results. Pi's smaller defaults must
// not silently truncate an accepted JSON value or change a successful tool result.
export const JSON_TOOL_OUTPUT_LIMITS = {
  maxBytes: JSON_MAX_BYTES,
  maxLines: JSON_MAX_BYTES,
} as const;
