import { computeProgram } from '../../src/extensions/openui/compute/browser';
(window as unknown as { computeProgram: typeof computeProgram }).computeProgram = computeProgram;
