import { it, expect } from 'vitest';
import { validateExtensions } from '../../src/server/extensions/registry';
import { policyHarness, policyInput, policyContext } from '../policy-fixture';
import { defineTool } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';

it('rejects duplicate extension, tool and task names before native installation', () => {
  expect(() => validateExtensions([{ name: 'x' }, { name: 'x' }])).toThrow('duplicate');
  expect(() =>
    validateExtensions([
      { name: 'a', tools: [{ name: 'read' }] },
      { name: 'b', tools: [{ name: 'read' }] },
    ] as any),
  ).toThrow('duplicate');
  expect(() =>
    validateExtensions([
      { name: 'a', tasks: [{ definition: { name: 'job', version: 1 } }] },
      { name: 'b', tasks: [{ definition: { name: 'job', version: 1 } }] },
    ] as any),
  ).toThrow('duplicate');
});
it('UI repair errors do not disable ordinary tools or model reasoning', async () => {
  let calls = 0;
  const extension = {
    name: 'repair-probe',
    tools: [
      defineTool({
        name: 'mcp_reference_lookup',
        description: 'fixture',
        replay: 'safe' as const,
        parameters: Type.Object({ query: Type.String() }),
        execute: async () => {
          calls++;
          return { isError: true, output: [{ type: 'text' as const, text: 'repair failed' }] };
        },
      }),
    ],
  };
  const pi = await policyHarness({ extensions: [extension], policy: { limits: { toolCalls: 4 } } });
  try {
    const root = await pi.root(policyContext, {
      agent: { model: { provider: 'fixture', modelId: 'fixture' } },
    });
    await policyInput(pi, root, 'mcp unsafe retry', 'repairs');
    await root.waitForIdle(policyContext);
    expect(calls).toBe(4);
    expect(
      (await root.context(policyContext)).messages.some((message) => message.role === 'assistant'),
    ).toBe(true);
  } finally {
    await pi.close(policyContext);
  }
});
