import { LIMITS } from '../shared/compute';

// These tools already validate their serialized results. Pi's smaller defaults must
// not silently truncate an accepted JSON value or change a successful tool result.
export const JSON_TOOL_OUTPUT_LIMITS = {
  maxBytes: LIMITS.json,
  maxLines: LIMITS.json,
} as const;
