import type { ScenarioInstance } from '../../shared/workspace';
import { AppError } from '../../shared/contracts';
import { resolveChat } from '../chat/directory';
export async function resolveScenario(env: Env, owner: string, id: string, includeDeleted = false) {
  const chatId = await env.DB.prepare(
    'SELECT s.main_chat_id FROM scenario_instances s JOIN conversations c ON c.id=s.main_chat_id WHERE s.id=? AND c.owner=?',
  )
    .bind(id, owner)
    .first<string>('main_chat_id');
  if (!chatId) throw new AppError(404, 'not_found');
  return resolveChat(env, owner, chatId, includeDeleted);
}
export async function listScenarios(
  env: Env,
  owner: string,
  kind: string,
): Promise<ScenarioInstance[]> {
  const { results } = await env.DB.prepare(
    "SELECT s.id,s.kind,s.workspace_id workspaceId,s.main_chat_id mainChatId,c.title,c.title_custom titleCustom,c.updated_at updatedAt FROM scenario_instances s JOIN conversations c ON c.id=s.main_chat_id WHERE c.owner=? AND s.kind=? AND c.lifecycle='active' ORDER BY c.updated_at DESC,s.id DESC LIMIT 100",
  )
    .bind(owner, kind)
    .all<ScenarioInstance>();
  return results.map((row) => ({ ...row, titleCustom: !!row.titleCustom }));
}
