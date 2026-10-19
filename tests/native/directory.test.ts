import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import baseline from '../../migrations/0001_initial.sql?raw';
import scenarios from '../../migrations/0003_scenarios.sql?raw';
import { createChat, listChats, resolveChat } from '../../src/server/chat/directory';
import { newConversationBindings } from '../../src/server/mcp/connections/catalog';
import { newSkillBindings } from '../../src/server/skills/catalog';
import { freezeDeploymentBindings } from '../../src/server/mcp/deployment';

vi.mock('../../src/server/mcp/connections/catalog', () => ({
  newConversationBindings: vi.fn(async () => []),
}));
vi.mock('../../src/server/skills/catalog', () => ({ newSkillBindings: vi.fn(async () => []) }));
vi.mock('../../src/server/mcp/deployment', () => ({
  mcpConfiguration: () => [],
  freezeDeploymentBindings: vi.fn(async () => []),
}));
const fixture = env as Env;
beforeAll(async () => {
  await fixture.DB.batch(
    baseline
      .split(';')
      .filter((sql) => sql.trim())
      .map((sql) => fixture.DB.prepare(sql)),
  );
  const trigger = scenarios.match(/CREATE TRIGGER[\s\S]*?END;/)![0];
  const rest = scenarios.replace(trigger, '');
  await fixture.DB.batch([
    ...rest
      .split(';')
      .filter((sql) => sql.trim())
      .map((sql) => fixture.DB.prepare(sql)),
    fixture.DB.prepare(trigger),
  ]);
});
beforeEach(async () => {
  await fixture.DB.prepare('DELETE FROM user').run();
  await fixture.DB.batch(
    ['owner', 'other'].map((owner) =>
      fixture.DB.prepare(
        'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,1,1)',
      ).bind(owner, owner, owner + '@example.test'),
    ),
  );
  vi.clearAllMocks();
  vi.mocked(newConversationBindings).mockResolvedValue([]);
  vi.mocked(newSkillBindings).mockResolvedValue([]);
  vi.mocked(freezeDeploymentBindings).mockResolvedValue([]);
});

it('concurrent retries create one chat, generation and set of frozen bindings', async () => {
  const request = { requestId: crypto.randomUUID(), skillIds: [] };
  const [a, b] = await Promise.all([
    createChat(fixture, 'owner', request),
    createChat(fixture, 'owner', request),
  ]);
  expect(a.id).toBe(b.id);
  expect(a.instance_generation).toBe(b.instance_generation);
  for (const table of [
    'conversations',
    'conversation_mcp_bindings',
    'conversation_skill_bindings',
    'conversation_deployment_mcp_bindings',
  ]) {
    expect(await fixture.DB.prepare('SELECT COUNT(*) n FROM ' + table).first('n')).toBe(1);
  }
  await fixture.DB.prepare(
    'UPDATE conversation_skill_bindings SET bindings=\'["frozen"]\' WHERE conversation=?',
  )
    .bind(a.id)
    .run();
  const calls = vi.mocked(newSkillBindings).mock.calls.length;
  expect((await createChat(fixture, 'owner', request)).id).toBe(a.id);
  expect(vi.mocked(newSkillBindings).mock.calls).toHaveLength(calls);
  expect(
    await fixture.DB.prepare(
      'SELECT bindings FROM conversation_skill_bindings WHERE conversation=?',
    )
      .bind(a.id)
      .first('bindings'),
  ).toBe('["frozen"]');
});

it('a lost D1 batch acknowledgement resolves the committed create receipt', async () => {
  const unstable = {
    ...fixture,
    DB: {
      prepare: fixture.DB.prepare.bind(fixture.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        await fixture.DB.batch(statements);
        throw new Error('acknowledgement lost');
      },
    } as unknown as D1Database,
  };
  const request = { requestId: crypto.randomUUID() };
  const created = await createChat(unstable, 'owner', request);
  expect((await createChat(fixture, 'owner', request)).id).toBe(created.id);
  expect(await fixture.DB.prepare('SELECT COUNT(*) n FROM conversations').first('n')).toBe(1);
});

it('canonical selections share a key while changed content conflicts and owners remain isolated', async () => {
  const a = crypto.randomUUID(),
    b = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const first = await createChat(fixture, 'owner', { requestId, skillIds: [b, a, a] });
  expect((await createChat(fixture, 'owner', { requestId, skillIds: [a, b] })).id).toBe(first.id);
  await expect(createChat(fixture, 'owner', { requestId, skillIds: [] })).rejects.toMatchObject({
    code: 'request_conflict',
  });
  expect((await createChat(fixture, 'other', { requestId, skillIds: [] })).id).not.toBe(first.id);
});

it('deleted minimal receipts reject create replay and normal resolution', async () => {
  const request = { requestId: crypto.randomUUID() };
  const chat = await createChat(fixture, 'owner', request);
  await fixture.DB.prepare(
    "UPDATE conversations SET lifecycle='deleted',title=NULL,title_custom=NULL,created_at=NULL,updated_at=NULL WHERE id=?",
  )
    .bind(chat.id)
    .run();
  await expect(createChat(fixture, 'owner', request)).rejects.toMatchObject({
    code: 'chat_deleted',
  });
  await expect(resolveChat(fixture, 'owner', chat.id)).rejects.toMatchObject({ code: 'not_found' });
  expect((await resolveChat(fixture, 'owner', chat.id, true)).instance_generation).toBe(
    chat.instance_generation,
  );
  expect((await listChats(fixture, 'owner')).items).toEqual([]);
  expect((await createChat(fixture, 'owner', { requestId: crypto.randomUUID() })).id).not.toBe(
    chat.id,
  );
});

it('uses keyset directory pages without duplicates when newer chats arrive', async () => {
  await fixture.DB.batch(
    Array.from({ length: 102 }, () =>
      fixture.DB.prepare(
        'INSERT INTO conversations(id,owner,create_request_id,create_hash,instance_generation,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      ).bind(
        crypto.randomUUID(),
        'owner',
        crypto.randomUUID(),
        'hash',
        crypto.randomUUID(),
        'chat',
        1,
        1,
      ),
    ),
  );
  const first = await listChats(fixture, 'owner');
  expect(first.items).toHaveLength(100);
  expect(first.next).toBeTypeOf('string');
  await createChat(fixture, 'owner', { requestId: crypto.randomUUID() });
  const second = await listChats(fixture, 'owner', first.next!);
  expect(second.items).toHaveLength(2);
  expect(new Set([...first.items, ...second.items].map((row) => row.id)).size).toBe(102);
  await expect(listChats(fixture, 'other', first.next!)).rejects.toMatchObject({
    code: 'invalid_cursor',
  });
  await expect(listChats(fixture, 'owner', '100')).rejects.toMatchObject({
    code: 'invalid_cursor',
  });
});
