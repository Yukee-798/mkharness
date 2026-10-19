import { expect, it } from 'vitest';
import { env } from './env';
import type { WorkspaceSnapshot, WorkspaceReceipt } from '../../src/shared/workspace';

it('Agent native tools and user writes share an independently observed workspace', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID()),
    actor = await stub.actor();
  const runId = crypto.randomUUID();
  expect(await stub.submitRun({ runId, text: 'report_workspace_probe' })).toMatchObject({
    accepted: true,
  });
  await (await stub.observeRun(runId)).text();
  const snapshot = (await stub.workspaceRead(actor, 'snapshot', {})) as WorkspaceSnapshot;
  expect(snapshot.objects).toHaveLength(1);
  expect(snapshot.objects[0]).toMatchObject({ type: 'report', title: 'Native report' });
  const events = await stub.workspaceWatch(actor),
    reader = events.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain('invalidate');
  const report = snapshot.objects[0];
  const command = {
    requestId: crypto.randomUUID(),
    name: 'report.publish',
    input: { id: report.id, title: 'User edited', source: '<h1>User edit while agent idle</h1>' },
    expected: { [report.id]: report.version },
  };
  expect((await stub.workspaceExecute(actor, command)) as WorkspaceReceipt).toMatchObject({
    status: 'committed',
  });
  const frame = new TextDecoder().decode((await reader.read()).value);
  expect(frame).toContain('watermark');
  await reader.cancel();
  expect(await stub.workspaceRead(actor, 'report', { id: report.id })).toMatchObject({
    source: '<h1>User edit while agent idle</h1>',
    revision: 2,
  });
  expect(await stub.workspaceExecute({ ...actor, ownerId: 'other' }, command)).toMatchObject({
    error: { status: 404 },
  });
  expect(
    await stub.workspaceExecute(actor, { ...command, requestId: crypto.randomUUID() }),
  ).toMatchObject({ error: { code: 'workspace_conflict' } });
});
