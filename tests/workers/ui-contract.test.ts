import { it, expect } from 'vitest';
import { panelTools, validateUI } from '../../src/extensions/openui/tools';
import { env } from 'cloudflare:test';
import { USER_ACTION_CONTEXT } from '../../src/shared/contracts';

it('rejects unavailable actions and unsafe static links before publishing any branch', async () => {
  for (const ui of [
    'root=Button("Open",Action([@OpenUrl("javascript:alert(1)")]))',
    'root=Button("Open",{type:"open_url",url:"https://user:password@example.com"})',
    'root=Button("Delete",{type:"delete_record",params:{id:42}})',
    'root=Button("Open",Action([{type:"open_url",url:"file:///etc/passwd"}]))',
    'root=Button("Open",{type:"open_url"})',
    '$show=false\nroot=Stack([$show ? Button("Open",Action([@OpenUrl("data:text/html,hello")])) : TextContent("Hidden")])',
  ])
    await expect(validateUI(ui, false), ui).rejects.toThrow();
});

it('keeps native actions, dynamic row links and prose containing action syntax valid', async () => {
  for (const ui of [
    '$url="https://example.com"\nroot=Stack([Button("Open",Action([@OpenUrl($url)])),Button("Legacy",{type:"open_url",url:$url}),Button("Preset",Action([@Set($url,"https://example.org")])),Button("Reset",Action([@Reset($url)])),Button("Explain",Action([@ToAssistant("Explain","Selected item B")]))])',
    'rows=[{url:"https://example.com"},{url:"https://example.org"}]\nroot=Stack(@Each(rows,"r",Button("Open",Action([@OpenUrl(r.url)]))))',
    'root=Stack([Button("Open",Action([{type:"open_url",url:"https://example.com"}])),Button("Explain",Action([{type:"continue_conversation",message:"Explain",context:"Selected item B"}]))])',
    'root=Button("Open",{type:"open_url",params:{url:"https://example.com"}})',
    'root=Stack([TextContent("@OpenUrl(\\"javascript:alert(1)\\") is an example, not an action"),TextContent("delete_record is unavailable")])',
  ])
    await expect(validateUI(ui, false), ui).resolves.toBeDefined();
  await expect(
    validateUI(
      '$amount="10"\nresult=Query("run_program",{amount:$amount},{total:0})\nroot=Stack([Button("Refresh",Action([@Run(result)])),TextContent(result.total)])',
      true,
    ),
  ).resolves.toBeDefined();
  const ui = panelTools(async () => []).sections!.find(
    (section) => section.key === 'openui-catalog',
  )!;
  const prompt = await ui.render({} as any, {} as any);
  expect(prompt).toContain('new browser tab without an agent request');
  expect(prompt).toContain('sourceContext.params (finite JSON, at most 16 KiB)');
});

it('retains action parameters in the committed model input for the source panel', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const settle = async () => {
    for (let attempt = 0; attempt < 600; attempt++) {
      const snapshot = JSON.parse(await stub.snapshot());
      if (!snapshot.pending.length) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Fixture did not settle');
  };
  await stub.submitRun({ runId: crypto.randomUUID(), text: 'panel' });
  const initial = await settle();
  const result = initial.entries
    .flatMap((entry: any) => entry.model ?? [])
    .find(
      (message: any) =>
        message.role === 'toolResult' && message.toolName === 'present_openui' && !message.isError,
    );
  const source = {
    action: 'extension_action' as const,
    extensionId: 'openui',
    name: 'continue',
    payload: {
      ref: JSON.parse(result.content[0].text).panelRef,
      state: { $choice: 'B' },
      params: { context: 'Selected item B', itemIndex: 1 },
    },
  };
  expect(
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'Explain this choice', source }),
  ).toMatchObject({ accepted: true });
  const snapshot = await settle();
  const user = snapshot.entries
    .flatMap((entry: any) => entry.model ?? [])
    .findLast((message: any) => message.role === 'user');
  const text =
    typeof user.content === 'string'
      ? user.content
      : user.content.map((part: any) => part.text ?? '').join('');
  expect(text).toBe(
    'Explain this choice' +
      USER_ACTION_CONTEXT +
      '\n' +
      JSON.stringify({ inputs: source.payload.state, params: source.payload.params }),
  );
});

it('requires computation provenance for program-backed StateSync while preserving simple local writeback', async () => {
  const ui = '$x=""\nroot=Stack([StateSync($x,"value",true)])';
  await expect(validateUI(ui, true)).rejects.toThrow('provenance');
  await expect(validateUI(ui, false)).resolves.toBeDefined();
});

it('supplies the native Query and binding grammar without replacing the entire Agent response format', async () => {
  const ui = panelTools(async () => []).sections!.find(
    (section) => section.key === 'openui-catalog',
  )!;
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
