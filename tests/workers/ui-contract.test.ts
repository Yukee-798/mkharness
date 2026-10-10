import { it, expect } from 'vitest';
import { panelTools, validateUI } from '../../src/server/panel-tools';
it('requires computation provenance for program-backed StateSync while preserving simple local writeback', async () => {
  const ui = '$x=""\nroot=Stack([StateSync($x,"value",true)])';
  await expect(validateUI(ui, true)).rejects.toThrow('provenance');
  await expect(validateUI(ui, false)).resolves.toBeDefined();
});

it('supplies the native Query and binding grammar without replacing the entire Agent response format', async () => {
  const ui = panelTools(async () => []).sections!.find((section) => section.key === 'ui')!;
  const prompt = await ui.render({} as any, {} as any);
  expect(prompt).toContain('only the ui argument of present_openui');
  expect(prompt).not.toContain('Your ENTIRE response must be valid');
  // These grammar sections come from OpenUI, rather than our extra application rules.
  expect(prompt).toContain('## Available Tools');
  expect(prompt).toContain('- run_program');
  expect(prompt).toContain('## Data Workflow');
  expect(prompt).toContain('Props marked `$binding<type>`');
  expect(prompt).toContain('@Reset($title)');
  expect(prompt).toContain('Mutation and other tools are unavailable');
});

it('rejects a program-backed static panel and accepts an explicitly bound local Query', async () => {
  const staticPanel = 'root=Stack([Input("amount","Amount","text"),Text("text","100")])';
  await expect(validateUI(staticPanel, true)).rejects.toThrow('run_program Query');
  await expect(validateUI(staticPanel, false)).resolves.toBeDefined();
  await expect(
    validateUI(
      '$amount="10"\nresult=Query("run_program",{amount:$amount},{total:0})\nroot=Stack([Input("amount","Amount","text",null,$amount),Text("text",result.total)])',
      true,
    ),
  ).resolves.toBeDefined();
});

it('requires component nodes in Card children and accepts a native Stack around a list', async () => {
  const items = 'items=[TextContent("First"),TextContent("Second")]';
  await expect(validateUI('root=Stack([Card([items])])\n' + items, false)).rejects.toThrow(
    'got array',
  );
  await expect(
    validateUI('root=Stack([Card([Stack(items)])])\n' + items, false),
  ).resolves.toBeDefined();
});

it('requires all definitions when publishing a replacement rather than an edit fragment', async () => {
  const fragment = 'root=Stack([header,body])\nheader=InlineHeader("Comparison")';
  await expect(validateUI(fragment, false)).rejects.toThrow('"unresolved":["body"]');
  await expect(
    validateUI(fragment + '\nbody=Table([Col("Option",["A","B"])])', false),
  ).resolves.toBeDefined();
});
