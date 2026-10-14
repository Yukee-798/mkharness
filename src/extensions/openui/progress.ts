export function validateProgress({ value = null, max = 100 }: { value?: unknown; max?: unknown }) {
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0)
    throw new Error('Progress requires a finite positive max');
  if (
    value !== null &&
    (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max)
  )
    throw new Error(
      'Progress requires a finite value between 0 and max, or null for unknown progress',
    );
}
