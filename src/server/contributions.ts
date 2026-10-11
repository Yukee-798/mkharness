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
export function validateContributionIds(ids: readonly string[]) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(id))
      throw new AppError(503, 'invalid_extension_id');
    if (seen.has(id)) throw new AppError(503, 'duplicate_extension_id', 'duplicate extension ID');
    seen.add(id);
  }
}
export function collectContributions(contributions: readonly ServerContribution[]) {
  validateContributionIds(contributions.map((contribution) => contribution.id));
  for (const contribution of contributions) {
    if (
      (contribution.resources &&
        (typeof contribution.resources.read !== 'function' ||
          (contribution.resources.validateState !== undefined &&
            typeof contribution.resources.validateState !== 'function'))) ||
      (contribution.projectTool !== undefined && typeof contribution.projectTool !== 'function') ||
      Object.entries(contribution.actions ?? {}).some(
        ([name, action]) =>
          !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(name) || typeof action?.normalize !== 'function',
      )
    )
      throw new AppError(503, 'invalid_extension_handler');
  }
  validateExtensions(
    contributions.flatMap((contribution) =>
      contribution.extension ? [contribution.extension] : [],
    ),
  );
  return contributions;
}
