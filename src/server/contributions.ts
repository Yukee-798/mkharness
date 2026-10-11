import type { EntryRecord, Extension } from '@earendil-works/pi-durable';
import type { Json as JsonValue } from '../shared/compute';
import { AppError } from '../shared/contracts';
import { validateExtensions } from './extensions';

/** Trusted deployment code. Read contexts do not expose execution, credentials or writes. */
export type ReadContext = { entries: () => Promise<readonly EntryRecord[]> };
export type ServerContribution = {
  id: string;
  extension?: Extension;
  resources?: {
    read(ref: string, context: ReadContext): Promise<{ data: JsonValue; initialState: JsonValue }>;
    validateState?(state: unknown): JsonValue;
  };
  actions?: Record<
    string,
    { normalize(payload: JsonValue, context: ReadContext): Promise<JsonValue> }
  >;
  projectTool?: (value: {
    toolName: string;
    output?: string;
    details?: JsonValue;
    terminal: boolean;
  }) => JsonValue;
};
export function collectContributions(contributions: readonly ServerContribution[]) {
  const seen = new Set<string>();
  for (const contribution of contributions) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(contribution.id))
      throw new AppError(503, 'invalid_extension_id');
    if (seen.has(contribution.id))
      throw new AppError(503, 'duplicate_extension_id', 'duplicate extension ID');
    seen.add(contribution.id);
  }
  validateExtensions(
    contributions.flatMap((contribution) =>
      contribution.extension ? [contribution.extension] : [],
    ),
  );
  return contributions;
}
