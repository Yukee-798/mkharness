/** Bound repeated runtime reports independently of platform request sampling. */
export function boundedReporter<T>(
  emit: (report: T, suppressed: number) => void,
  now: () => number = Date.now,
) {
  let startsAt: number | undefined;
  let emitted = 0;
  let suppressed = 0;
  return (report: T) => {
    const time = now();
    if (startsAt === undefined || time - startsAt >= 30_000) {
      startsAt = time;
      emitted = 0;
    }
    if (emitted >= 5) {
      suppressed = Math.min(Number.MAX_SAFE_INTEGER, suppressed + 1);
      return;
    }
    emitted += 1;
    emit(report, suppressed);
    suppressed = 0;
  };
}
