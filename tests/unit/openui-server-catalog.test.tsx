// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { generatePrompt } from '@openuidev/lang-core';
import { library } from '../../src/extensions/openui/catalog';
import { schema, spec } from 'virtual:mkharness-openui-catalog';
it('derives identical server schema and native prompts without serializing React or library instance IDs', () => {
  expect(schema).toEqual(library.toJSONSchema());
  const options = {
    preamble: 'fixture',
    bindings: true,
    toolCalls: true,
    tools: ['run_program'],
    additionalRules: ['fixture rule'],
  };
  expect(generatePrompt({ ...spec, ...options })).toBe(library.prompt(options));
  expect(JSON.stringify({ schema, spec })).not.toContain(library.__libraryId);
  expect(JSON.parse(JSON.stringify({ schema, spec }))).toEqual({ schema, spec });
});
