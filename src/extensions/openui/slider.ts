export const MAX_SLIDER_OPTIONS = 256;
export function validateSlider(props: {
  min?: unknown;
  max?: unknown;
  step?: unknown;
  variant?: unknown;
}) {
  const { min, max, step = 1, variant } = props;
  if (
    typeof min !== 'number' ||
    typeof max !== 'number' ||
    typeof step !== 'number' ||
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    !Number.isFinite(step) ||
    max <= min ||
    step <= 0
  )
    throw new Error('Slider requires finite min < max and a positive step');
  if (variant === 'discrete' && Math.floor((max - min) / step) + 1 > MAX_SLIDER_OPTIONS)
    throw new Error(
      `Slider has more than ${MAX_SLIDER_OPTIONS} discrete options; increase step or use continuous`,
    );
}
