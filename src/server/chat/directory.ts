import { z } from 'zod';
import scenarioConfiguration from '../../../scenarios.config';
import { AppError, type CreateConversationRequest } from '../../shared/contracts';
import { canonicalJson } from '../../shared/json';
import { newConversationBindings } from '../mcp/connections/catalog';
import { freezeDeploymentBindings, mcpConfiguration } from '../mcp/deployment';
import { newSkillBindings } from '../skills/catalog';
import { extensionEnabled } from '../../extensions/configuration';
import type { ChatActor } from './protocol';

export type ChatDirectoryRow = {
  id: string;
  scenario_id?: string;
  workspace_id?: string;
  runtime_name?: string;
  kind?: string;
  owner: string;
  create_request_id: string;
  create_hash: string;
  instance_generation: string;
  lifecycle: 'active' | 'deleting' | 'deleted';
  title: string | null;
  title_custom: number | null;
  created_at: number | null;
  updated_at: number | null;
};
const directoryCursorSchema = z
  .object({
    v: z.literal(1),
    owner: z.string().min(1),
    time: z.number().int().nonnegative(),
    id: z.uuid(),
  })
  .strict();

function directoryCursor(raw: string | undefined, owner: string) {
  if (raw === undefined) return;
  try {
    if (!raw || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const value = directoryCursorSchema.parse(
      JSON.parse(atob(raw.replaceAll('-', '+').replaceAll('_', '/'))),
    );
    if (value.owner !== owner) throw new Error();
    return value;
  } catch {
    throw new AppError(400, 'invalid_cursor');
  }
}

export async function listChats(env: Env, owner: string, rawCursor?: string) {
  const cursor = directoryCursor(rawCursor, owner);
  const statement = cursor
    ? env.DB.prepare(
        "SELECT id,title,created_at,updated_at FROM conversations WHERE owner=? AND lifecycle='active' AND id IN (SELECT main_chat_id FROM scenario_instances WHERE kind='agent') AND (updated_at<? OR (updated_at=? AND id<?)) ORDER BY updated_at DESC,id DESC LIMIT 101",
      ).bind(owner, cursor.time, cursor.time, cursor.id)
    : env.DB.prepare(
        "SELECT id,title,created_at,updated_at FROM conversations WHERE owner=? AND lifecycle='active' AND id IN (SELECT main_chat_id FROM scenario_instances WHERE kind='agent') ORDER BY updated_at DESC,id DESC LIMIT 101",
      ).bind(owner);
  const { results } = await statement.all<{
    id: string;
    title: string;
    created_at: number;
    updated_at: number;
  }>();
  const items = results.slice(0, 100);
  const last = items.at(-1);
  return {
    items,
    next:
      results.length > 100 && last
        ? btoa(JSON.stringify({ v: 1, owner, time: last.updated_at, id: last.id }))
            .replaceAll('+', '-')
            .replaceAll('/', '_')
            .replace(/=+$/, '')
        : null,
  };
}

export async function resolveChat(env: Env, owner: string, id: string, includeDeleted = false) {
  const row = await env.DB.prepare(
    'SELECT c.*,s.id scenario_id,s.workspace_id,s.runtime_name,s.kind FROM conversations c JOIN scenario_instances s ON s.main_chat_id=c.id WHERE c.id=? AND c.owner=?',
  )
    .bind(id, owner)
    .first<ChatDirectoryRow>();
  if (!row || (!includeDeleted && row.lifecycle !== 'active')) throw new AppError(404, 'not_found');
  return row;
}

export function directoryActor(row: ChatDirectoryRow): ChatActor {
  return {
    chatId: row.id,
    ownerId: row.owner,
    generation: row.instance_generation,
    runtimeName: row.runtime_name ?? row.id,
    scenarioId: row.scenario_id ?? row.id,
    workspaceId: row.workspace_id ?? `workspace:${row.id}`,
    scenarioKind: row.kind ?? 'agent',
  };
}

function existingCreation(row: ChatDirectoryRow, hash: string) {
  if (row.create_hash !== hash) throw new AppError(409, 'request_conflict');
  if (row.lifecycle !== 'active') throw new AppError(410, 'chat_deleted');
  return row;
}

/** The unique create key owns the directory row and all frozen bindings in one D1 transaction. */
export async function createChat(
  env: Env,
  owner: string,
  request: CreateConversationRequest,
  kind = 'agent',
) {
  if (!scenarioConfiguration.scenes.some((scene) => scene.id === kind))
    throw new AppError(400, 'unknown_scenario');
  // Omitted arrays mean account defaults. Explicit [] means no selected sources.
  const selection = {
    ...(request.mcpConnectionIds !== undefined
      ? { mcpConnectionIds: [...new Set(request.mcpConnectionIds)].sort() }
      : {}),
    ...(request.skillIds !== undefined ? { skillIds: [...new Set(request.skillIds)].sort() } : {}),
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      canonicalJson({ ...selection, ...(kind === 'agent' ? {} : { kind }) }),
    ),
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const receipt = () =>
    env.DB.prepare(
      'SELECT c.*,s.id scenario_id,s.workspace_id,s.runtime_name,s.kind FROM conversations c JOIN scenario_instances s ON s.main_chat_id=c.id WHERE c.owner=? AND c.create_request_id=?',
    )
      .bind(owner, request.requestId)
      .first<ChatDirectoryRow>();
  const existing = await receipt();
  if (existing) return existingCreation(existing, hash);

  const [mcp, skills, deployment] = await Promise.all([
    newConversationBindings(env, owner, selection.mcpConnectionIds),
    newSkillBindings(env, owner, selection.skillIds),
    freezeDeploymentBindings(
      env,
      owner,
      extensionEnabled('mcp') ? mcpConfiguration({ ...env }) : [],
    ),
  ]);
  const id = crypto.randomUUID();
  const generation = crypto.randomUUID();
  const scenarioId = crypto.randomUUID(),
    workspaceId = crypto.randomUUID(),
    runtimeName = `scenario:${scenarioId}`;
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO conversations(id,owner,create_request_id,create_hash,instance_generation,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      ).bind(
        id,
        owner,
        request.requestId,
        hash,
        generation,
        kind === 'canvas' ? '未命名创作' : '新聊天',
        now,
        now,
      ),
      env.DB.prepare(
        'UPDATE scenario_instances SET id=?,workspace_id=?,runtime_name=?,kind=? WHERE main_chat_id=?',
      ).bind(scenarioId, workspaceId, runtimeName, kind, id),
      env.DB.prepare(
        'INSERT INTO conversation_mcp_bindings(conversation,bindings) VALUES(?,?)',
      ).bind(id, JSON.stringify(mcp)),
      env.DB.prepare(
        'INSERT INTO conversation_skill_bindings(conversation,bindings) VALUES(?,?)',
      ).bind(id, JSON.stringify(skills)),
      env.DB.prepare(
        'INSERT INTO conversation_deployment_mcp_bindings(conversation,bindings) VALUES(?,?)',
      ).bind(id, JSON.stringify(deployment)),
    ]);
  } catch (error) {
    // A competing request or lost batch acknowledgement can have committed first.
    const winner = await receipt();
    if (winner) return existingCreation(winner, hash);
    throw error;
  }
  return (await receipt())!;
}
