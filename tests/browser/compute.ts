import {computeProgram} from '../../src/browser/compute';
(window as unknown as {computeProgram:typeof computeProgram}).computeProgram=computeProgram;
