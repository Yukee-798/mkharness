import { expect, it } from 'vitest';
import { env } from './env';
import app from '../../src/server/index';
import { makeSignature } from 'better-auth/crypto';
import type { WorkspaceSnapshot, WorkspaceReceipt } from '../../src/shared/workspace';
it('exports an owned generated asset into standalone HTML and refuses foreign asset references', async () => {
  const stub = env.IMAGE_PROBES.getByName(crypto.randomUUID());
  await stub.imageProbe('ready');
  const actor = await stub.actor(),
    runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'image_generation_probe' });
  await (await stub.observeRun(runId)).text();
  const snapshot = (await stub.workspaceRead(actor, 'snapshot', {})) as WorkspaceSnapshot;
  expect(snapshot.assets).toHaveLength(1);
  const source = `<h1 id="summary">Image report</h1><img src="workspace-asset:${snapshot.assets[0].id}"><script>window.reportReady=true</script>`;
  const request = {
    requestId: crypto.randomUUID(),
    name: 'report.publish',
    input: { title: 'Image report', source },
    expected: {},
  };
  const receipt = (await stub.workspaceExecute(actor, request)) as WorkspaceReceipt;
  const token = crypto.randomUUID(),
    now = Date.now();
  await env.DB.prepare(
    'INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)',
  )
    .bind(crypto.randomUUID(), now + 60000, token, now, now, actor.ownerId)
    .run();
  const headers = {
    cookie:
      'better-auth.session_token=' +
      encodeURIComponent(token + '.' + (await makeSignature(token, env.BETTER_AUTH_SECRET))),
  };
  const response = await app.request(
    `${env.APP_URL}/api/scenarios/${actor.scenarioId}/reports/${receipt.objectIds[0]}/export`,
    { headers },
    { ...env, CONVERSATIONS: env.IMAGE_PROBES } as unknown as Env,
  );
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('data:image/png;base64,');
  expect(html).not.toContain('workspace-asset:');
  expect(html).not.toContain('report:connect');
  expect(html).not.toContain('/api/');
  expect(response.headers.get('Content-Disposition')).toContain('attachment');
  expect(html).toContain('Chart dependencies could not load.');
  const chinese = await app.request(
    `${env.APP_URL}/api/scenarios/${actor.scenarioId}/reports/${receipt.objectIds[0]}/export?locale=zh-CN`,
    { headers },
    { ...env, CONVERSATIONS: env.IMAGE_PROBES } as unknown as Env,
  );
  expect(chinese.status).toBe(200);
  const chineseHtml = await chinese.text();
  expect(chineseHtml).toContain('图表依赖加载失败，请检查网络后重新打开报告。');
  expect(chineseHtml).toContain('<h1 id="summary">Image report</h1>');
  expect(
    await stub.workspaceExecute(actor, {
      ...request,
      requestId: crypto.randomUUID(),
      input: { title: 'Foreign', source: '<img src="workspace-asset:other-project">' },
    }),
  ).toMatchObject({ error: { code: 'report_asset_unavailable' } });
});
