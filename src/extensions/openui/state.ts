import type { RawState } from '../../shared/contracts';
import { finiteJson } from '../../shared/json';

/** Encode the SDK snapshot at the extension boundary, before saving or submitting.
 * Native unbound fields include optional metadata such as componentType: undefined.
 * Undefined object properties mean absent; every represented value remains strict JSON.
 */
export function inputState(raw: Record<string, unknown>): RawState {
  const ancestors = new Set<object>();
  const encode = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') {
      finiteJson(value);
      return value;
    }
    if (ancestors.has(value)) throw new Error('Input state contains a cycle');
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw new Error('Input state must contain plain JSON values');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set))
      throw new Error('Input state cannot contain accessors');
    ancestors.add(value);
    const result = array
      ? Array.from({ length: value.length }, (_, index) => encode(descriptors[index]?.value))
      : Object.fromEntries(
          Object.entries(descriptors)
            .filter(([, descriptor]) => descriptor.value !== undefined)
            .map(([key, descriptor]) => [key, encode(descriptor.value)]),
        );
    ancestors.delete(value);
    return result;
  };
  const state = encode(raw);
  finiteJson(state);
  return state as RawState;
}
