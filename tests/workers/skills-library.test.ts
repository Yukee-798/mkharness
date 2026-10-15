import { env, abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { makeSignature } from 'better-auth/crypto';
import { zipSync, strToU8 } from 'fflate';
import app from '../../src/server/index';
import { importSkill } from '../../src/server/skills/package';
import { skillSource, newSkillBindings, changeSkill } from '../../src/server/skills/catalog';
import type { SkillView } from '../../src/shared/skills';

const markdown = (body = 'Read references/checklist.md before answering. PRIVATE_SKILL_V1') =>
  `---\nname: delivery-guide\ndescription: Prepare a delivery summary using its checklist.\n---\n${body}`;
const bundle = (body?: string) =>
  zipSync({
    'delivery-guide/SKILL.md': strToU8(markdown(body)),
    'delivery-guide/references/checklist.md': strToU8(
      'CHECKLIST_MARKER: scope, evidence, open questions.',
    ),
    'delivery-guide/scripts/helper.py': strToU8('raise Exception("MUST_NOT_RUN")'),
  });
async function identity() {
  const id = crypto.randomUUID(),
    token = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)',
  )
    .bind(id, id, `${id}@example.test`, Date.now(), Date.now())
    .run();
  await env.DB.prepare('INSERT INTO session VALUES(?,?,?,?,?,NULL,NULL,?)')
    .bind(crypto.randomUUID(), Date.now() + 86400000, token, Date.now(), Date.now(), id)
    .run();
  const cookie =
    'better-auth.session_token=' +
    encodeURIComponent(token + '.' + (await makeSignature(token, env.BETTER_AUTH_SECRET!)));
  return { id, headers: { cookie, origin: env.APP_URL, 'Content-Type': 'application/json' } };
}
async function call(
  headers: Record<string, string>,
  path: string,
  method = 'GET',
  body?: BodyInit,
) {
  return app.request('http://localhost:5173/api' + path, { headers, method, body }, env);
}
const bytesBody = (value: Uint8Array) => value as unknown as BodyInit;
it('previews native SKILL.md packages and rejects traversal, ambiguity, oversized and malformed input', async () => {
  const result = await importSkill(bundle(), 'guide.zip');
  expect(result.preview).toMatchObject({
    name: 'delivery-guide',
    body: expect.stringContaining('PRIVATE_SKILL_V1'),
  });
  expect(result.preview.warnings).toContain('Scripts are stored as files and cannot be executed.');
  expect(result.preview.files.map((f) => f.path)).toContain('references/checklist.md');
  expect(result.preview.version).toBe((await importSkill(bundle(), 'same.zip')).preview.version);
  for (const path of ['../secret.md', '/absolute.md', 'bad\\path.md', 'a/./bad.md']) {
    await expect(
      importSkill(zipSync({ 'SKILL.md': strToU8(markdown()), [path]: strToU8('bad') }), 'bad.zip'),
    ).rejects.toThrow();
  }
  await expect(
    importSkill(
      zipSync({ 'one/SKILL.md': strToU8(markdown()), 'two/SKILL.md': strToU8(markdown()) }),
      'two.zip',
    ),
  ).rejects.toThrow('skill_package_requires_one_skill');
  await expect(
    importSkill(
      zipSync({
        'SKILL.md': strToU8(markdown()),
        'references/bomb.md': strToU8('x'.repeat(1024 * 1024)),
      }),
      'bomb.zip',
    ),
  ).rejects.toThrow();
  await expect(importSkill(strToU8('no metadata'), 'SKILL.md')).rejects.toThrow(
    'invalid_skill_markdown',
  );
  for (const description of ['', 'description:   \n', 'description: 123\n'])
    await expect(
      importSkill(
        strToU8(`---\nname: delivery-guide\n${description}---\nInstructions`),
        'SKILL.md',
      ),
    ).rejects.toThrow('invalid_skill_markdown');
  await expect(importSkill(strToU8(markdown()), 'install.exe')).rejects.toThrow('skill_file_type');
});
it('uses authenticated ownership, origin checks, revision CAS and private preview routes', async () => {
  const owner = await identity(),
    other = await identity();
  expect((await call({}, '/skills')).status).toBe(401);
  expect(
    (
      await call(
        { ...owner.headers, origin: 'https://evil.test' },
        '/skills',
        'POST',
        bytesBody(bundle()),
      )
    ).status,
  ).toBe(403);
  const created = await call(
    owner.headers,
    '/skills?filename=guide.zip',
    'POST',
    bytesBody(bundle()),
  );
  expect(created.status).toBe(201);
  const { skill } = (await created.json()) as { skill: SkillView };
  expect(skill).not.toHaveProperty('body');
  expect(
    JSON.stringify(
      await env.DB.prepare('SELECT preview FROM skill_versions WHERE skill_id=?')
        .bind(skill.id)
        .first(),
    ),
  ).not.toContain('PRIVATE_SKILL_V1');
  expect(await (await call(owner.headers, `/skills/${skill.id}`)).json()).toMatchObject({
    preview: { body: expect.stringContaining('PRIVATE_SKILL_V1') },
  });
  expect(await (await call(other.headers, '/skills')).json()).toEqual({ skills: [] });
  for (const [path, method, body] of [
    [`/skills/${skill.id}`, 'GET'],
    [`/skills/${skill.id}`, 'PATCH', JSON.stringify({ revision: 1, enabled: false })],
    [`/skills/${skill.id}/versions?filename=guide.zip`, 'POST', bytesBody(bundle())],
  ] as const) {
    expect((await call(other.headers, path, method, body)).status).toBe(404);
  }
  expect(
    (await call(owner.headers, '/skills?filename=guide.zip', 'POST', bytesBody(bundle()))).status,
  ).toBe(409);
  const updated = await call(
    owner.headers,
    `/skills/${skill.id}`,
    'PATCH',
    JSON.stringify({ revision: 1, enabled: false }),
  );
  expect(updated.status).toBe(200);
  expect(await newSkillBindings(env as Env, owner.id)).toEqual([]);
  await expect(newSkillBindings(env as Env, owner.id, [skill.id])).rejects.toThrow(
    'skill_unavailable',
  );
  expect(
    (await call(owner.headers, `/skills/${skill.id}`, 'DELETE', JSON.stringify({ revision: 1 })))
      .status,
  ).toBe(409);
  expect(
    (await call(owner.headers, `/skills/${skill.id}`, 'DELETE', JSON.stringify({ revision: 2 })))
      .status,
  ).toBe(200);
});
it('pins versions per chat, loads through native Pi tools, restores receipts and never executes scripts', async () => {
  const owner = await identity();
  const { skill } = (await (
    await call(owner.headers, '/skills?filename=guide.zip', 'POST', bytesBody(bundle()))
  ).json()) as { skill: SkillView };
  const { id } = (await (
    await call(
      owner.headers,
      '/conversations',
      'POST',
      JSON.stringify({ skillIds: [skill.id], mcpConnectionIds: [] }),
    )
  ).json()) as { id: string };
  const bindings = await newSkillBindings(env as Env, owner.id);
  expect(await newSkillBindings(env as Env, owner.id, [])).toEqual([]);
  const { skill: next } = (await (
    await call(
      { ...owner.headers, 'If-Match': '1' },
      `/skills/${skill.id}/versions?filename=guide.zip`,
      'POST',
      bytesBody(bundle('PRIVATE_SKILL_V2')),
    )
  ).json()) as { skill: SkillView };
  expect(next.version).not.toBe(skill.version);
  const old = await skillSource(env as Env, owner.id, bindings[0]!);
  expect((await old.load('delivery-guide'))?.body).toContain('PRIVATE_SKILL_V1');
  expect(await old.readResource?.('delivery-guide', '../scripts/helper.py')).toBeNull();
  expect((await old.readResource?.('delivery-guide', 'scripts/helper.py'))?.content).toContain(
    'MUST_NOT_RUN',
  );
  const run = await call(
    owner.headers,
    `/conversations/${id}/runs`,
    'POST',
    JSON.stringify({ runId: crypto.randomUUID(), text: 'custom_skill_probe' }),
  );
  expect(run.status).toBe(202);
  let snapshot: any;
  for (let i = 0; i < 100; i++) {
    snapshot = await (await call(owner.headers, `/conversations/${id}/snapshot`)).json();
    if (!snapshot.pending.length) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(snapshot.pending).toHaveLength(0);
  const results = snapshot.entries
    .flatMap((e: any) => e.model ?? [])
    .filter((m: any) => m.role === 'toolResult');
  expect(results.map((m: any) => m.toolName)).toEqual(['activate_skill', 'read_skill_resource']);
  expect(results.every((m: any) => !m.isError)).toBe(true);
  expect(JSON.stringify(results)).toContain('PRIVATE_SKILL_V1');
  expect(JSON.stringify(results)).not.toContain('PRIVATE_SKILL_V2');
  expect(JSON.stringify(results)).toContain('CHECKLIST_MARKER');
  expect(snapshot.extensionState.skills.available[0].version).toBe(skill.version);
  expect(snapshot.extensionState.skills.loaded[0]).toMatchObject({
    name: 'delivery-guide',
    version: skill.version,
  });
  await changeSkill(env as Env, owner.id, skill.id, next.revision);
  await abortAllDurableObjects();
  const restored = (await (
    await call(owner.headers, `/conversations/${id}/snapshot`)
  ).json()) as any;
  expect(restored.extensionState.skills).toEqual(snapshot.extensionState.skills);
  expect(await newSkillBindings(env as Env, owner.id)).toEqual([]);
});
