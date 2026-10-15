import type { SkillSource, SkillResource } from 'agents/skills';
import { AppError } from '../../shared/contracts';
import {
  SKILL_LIMITS,
  type SkillPreview,
  type SkillView,
  type SkillBinding,
  type SkillFile,
} from '../../shared/skills';
import { extensionEnabled } from '../../extensions/configuration';
import { importSkill, parseInstructions, sha256, safeSkillPath } from './package';

type Row = {
  id: string;
  name: string;
  owner: string;
  current_version: string;
  enabled: number;
  revision: number;
  updated_at: number;
  prefix: string;
  preview: string;
};
export const skillsEnabled = () => extensionEnabled('skills');
function bucket(env: Env) {
  if (!env.SKILL_FILES) throw new AppError(503, 'skill_storage_unavailable');
  return env.SKILL_FILES;
}
const view = (row: Row): SkillView => {
  const { body: _body, files: _files, ...metadata } = JSON.parse(row.preview) as SkillPreview;
  return {
    ...metadata,
    id: row.id,
    enabled: !!row.enabled,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
};
export async function ownedSkill(env: Env, owner: string, id: string): Promise<Row> {
  const row = await env.DB.prepare(
    'SELECT s.*,v.prefix,v.preview FROM skills s JOIN skill_versions v ON v.skill_id=s.id AND v.version=s.current_version WHERE s.id=? AND s.owner=? AND s.deleted_at IS NULL',
  )
    .bind(id, owner)
    .first<Row>();
  if (!row) throw new AppError(404, 'skill_not_found');
  return row;
}
export async function skillViews(env: Env, owner: string): Promise<SkillView[]> {
  const { results } = await env.DB.prepare(
    'SELECT s.*,v.prefix,v.preview FROM skills s JOIN skill_versions v ON v.skill_id=s.id AND v.version=s.current_version WHERE s.owner=? AND s.deleted_at IS NULL ORDER BY s.updated_at DESC,s.id',
  )
    .bind(owner)
    .all<Row>();
  return results.map(view);
}
export async function skillPreview(env: Env, owner: string, id: string): Promise<SkillPreview> {
  const row = await ownedSkill(env, owner, id);
  const manifest = JSON.parse(row.preview) as Omit<SkillPreview, 'body'>;
  const source = await skillSource(env, owner, {
    id: row.id,
    name: row.name,
    description: manifest.description,
    version: row.current_version,
  });
  const content = await source.load(row.name);
  if (!content) throw new AppError(503, 'skill_version_unavailable');
  return { ...manifest, body: content.body };
}
export async function publishSkill(
  env: Env,
  owner: string,
  bytes: Uint8Array,
  filename: string,
  update?: { id: string; revision: number },
) {
  const current = update ? await ownedSkill(env, owner, update.id) : undefined;
  if (current && current.revision !== update!.revision)
    throw new AppError(409, 'skill_revision_conflict');
  const { preview, files } = await importSkill(bytes, filename);
  // Keep library scans and conversation admission metadata-only. Bodies live in R2.
  const { body: _body, ...manifest } = preview;
  if (current && current.name !== preview.name) throw new AppError(400, 'skill_name_changed');
  if (!current) {
    const { n } = (await env.DB.prepare(
      'SELECT COUNT(*) n FROM skills WHERE owner=? AND deleted_at IS NULL',
    )
      .bind(owner)
      .first<{ n: number }>())!;
    if (n >= 32) throw new AppError(429, 'skill_library_limit');
    if (
      await env.DB.prepare('SELECT id FROM skills WHERE owner=? AND name=? AND deleted_at IS NULL')
        .bind(owner, preview.name)
        .first()
    )
      throw new AppError(409, 'duplicate_skill_name');
  }
  const id = current?.id ?? crypto.randomUUID(),
    store = bucket(env);
  const existing = await env.DB.prepare(
    'SELECT prefix FROM skill_versions WHERE skill_id=? AND version=?',
  )
    .bind(id, preview.version)
    .first<{ prefix: string }>();
  const prefix = existing?.prefix ?? `skills/${owner}/${id}/${crypto.randomUUID()}/`;
  const written: string[] = [];
  let committed = false;
  try {
    if (!existing)
      for (const [path, data] of files) {
        const key = prefix + path;
        await store.put(key, data, { httpMetadata: { contentType: 'application/octet-stream' } });
        written.push(key);
      }
    const now = Date.now();
    const published = current
      ? env.DB.prepare(
          'UPDATE skills SET current_version=?,revision=revision+1,updated_at=? WHERE id=? AND owner=? AND revision=? AND deleted_at IS NULL RETURNING id',
        ).bind(preview.version, now, id, owner, update!.revision)
      : env.DB.prepare(
          'INSERT INTO skills(id,owner,name,current_version,updated_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM skills WHERE owner=? AND deleted_at IS NULL)<32 RETURNING id',
        ).bind(id, owner, preview.name, preview.version, now, owner);
    const result = await env.DB.batch([
      published,
      env.DB.prepare(
        'INSERT OR IGNORE INTO skill_versions(skill_id,version,prefix,preview) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM skills WHERE id=? AND owner=? AND current_version=? AND revision=? AND deleted_at IS NULL)',
      ).bind(
        id,
        preview.version,
        prefix,
        JSON.stringify(manifest),
        id,
        owner,
        preview.version,
        current ? current.revision + 1 : 1,
      ),
    ]);
    if (!result[0].results.length) throw new AppError(409, 'skill_revision_conflict');
    committed = true;
    // A competing identical publication can win the immutable version insert.
    const saved = await env.DB.prepare(
      'SELECT prefix FROM skill_versions WHERE skill_id=? AND version=?',
    )
      .bind(id, preview.version)
      .first<{ prefix: string }>();
    if (saved?.prefix !== prefix && written.length) await store.delete(written);
    return view(await ownedSkill(env, owner, id));
  } catch (e) {
    if (!committed && written.length) await store.delete(written);
    if (String(e).includes('UNIQUE constraint failed'))
      throw new AppError(409, 'duplicate_skill_name');
    throw e;
  }
}
export async function changeSkill(
  env: Env,
  owner: string,
  id: string,
  revision: number,
  enabled?: boolean,
) {
  await ownedSkill(env, owner, id);
  const result = await env.DB.prepare(
    enabled === undefined
      ? 'UPDATE skills SET deleted_at=?,enabled=0,revision=revision+1 WHERE id=? AND owner=? AND revision=? AND deleted_at IS NULL RETURNING id'
      : 'UPDATE skills SET enabled=?,revision=revision+1 WHERE id=? AND owner=? AND revision=? AND deleted_at IS NULL RETURNING id',
  )
    .bind(enabled === undefined ? Date.now() : Number(enabled), id, owner, revision)
    .first();
  if (!result) throw new AppError(409, 'skill_revision_conflict');
  return enabled === undefined
    ? { deleted: true }
    : { skill: view(await ownedSkill(env, owner, id)) };
}
export async function newSkillBindings(
  env: Env,
  owner: string,
  ids?: string[],
): Promise<SkillBinding[]> {
  if (!skillsEnabled()) {
    if (ids?.length) throw new AppError(400, 'skills_disabled');
    return [];
  }
  const views = await skillViews(env, owner);
  if (ids?.some((id) => !views.some((s) => s.id === id && s.enabled)))
    throw new AppError(400, 'skill_unavailable');
  const selected = views.filter((s) => s.enabled && (!ids || ids.includes(s.id)));
  if (selected.length > SKILL_LIMITS.selected) throw new AppError(400, 'skill_selection_limit');
  return selected.map(({ id, name, description, version }) => ({ id, name, description, version }));
}
export async function conversationSkills(env: Env, conversation: string) {
  const row = await env.DB.prepare(
    'SELECT c.owner,b.bindings FROM conversations c JOIN conversation_skill_bindings b ON b.conversation=c.id WHERE c.id=?',
  )
    .bind(conversation)
    .first<{ owner: string; bindings: string }>();
  return row
    ? { owner: row.owner, bindings: JSON.parse(row.bindings) as SkillBinding[] }
    : { owner: '', bindings: [] };
}
/** Only the immutable, owner-checked version selected by a conversation can become a source. */
export async function skillSource(
  env: Env,
  owner: string,
  binding: SkillBinding,
): Promise<SkillSource> {
  const row = await env.DB.prepare(
    'SELECT v.prefix,v.preview FROM skill_versions v JOIN skills s ON s.id=v.skill_id WHERE s.owner=? AND s.id=? AND v.version=?',
  )
    .bind(owner, binding.id, binding.version)
    .first<{ prefix: string; preview: string }>();
  if (!row) throw new AppError(503, 'skill_version_unavailable');
  const preview = JSON.parse(row.preview) as SkillPreview;
  const read = async (file: SkillFile) => {
    if (!safeSkillPath(file.path)) throw new AppError(503, 'invalid_skill_path');
    const object = await bucket(env).get(row.prefix + file.path);
    if (!object || object.size !== file.size || object.size > SKILL_LIMITS.file)
      throw new AppError(503, 'skill_resource_unavailable');
    const data = new Uint8Array(await object.arrayBuffer());
    if ((await sha256(data)) !== file.sha256) throw new AppError(503, 'skill_resource_changed');
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  };
  const descriptor = {
    name: binding.name,
    description: binding.description,
    version: binding.version,
    sourceId: binding.id,
  };
  return {
    id: binding.id,
    fingerprint: binding.version,
    list: async () => [descriptor],
    load: async (name) => {
      if (name !== binding.name) return null;
      const root = preview.files.find((f) => f.path === 'SKILL.md');
      if (!root) throw new AppError(503, 'skill_version_unavailable');
      const parsed = parseInstructions(await read(root));
      if (parsed.name !== binding.name) throw new AppError(503, 'skill_resource_changed');
      return {
        ...parsed,
        ...descriptor,
        resources: preview.files.filter((f) => f.path !== 'SKILL.md'),
      };
    },
    readResource: async (name, path): Promise<SkillResource | null> => {
      const file = preview.files.find((f) => f.path === path && path !== 'SKILL.md');
      if (name !== binding.name || !file || file.encoding === 'base64') return null;
      return { ...file, content: await read(file) };
    },
  };
}
