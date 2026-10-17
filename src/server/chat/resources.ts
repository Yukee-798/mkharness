import type { ConversationId } from '@earendil-works/pi-durable';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import { AppError } from '../../shared/contracts';
import { jsonText, type Json } from '../../shared/json';
import type { ReadContext, ServerContribution } from '../extensions/contributions';

type ResourceSource = {
  database: SqliteDatabase;
  contributions: () => Promise<readonly ServerContribution[]>;
  readContext: (target: ConversationId) => ReadContext;
};

/** Private to one authorized chat; extensions resolve visibility for the explicit native target. */
export class ChatResources {
  private schema?: Promise<void>;
  constructor(private source: ResourceSource) {}

  private ready() {
    return (this.schema ??= this.source.database.exec(
      'CREATE TABLE IF NOT EXISTS app_resource_states(conversation_id INTEGER NOT NULL,ref TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(conversation_id,ref))',
    ));
  }

  private async resource(target: ConversationId, extensionId: string, ref: string) {
    const handler = (await this.source.contributions()).find(
      (contribution) => contribution.id === extensionId,
    )?.resources;
    if (!handler) throw new AppError(404, 'resource_not_found');
    const value = await handler.read(ref, this.source.readContext(target));
    try {
      jsonText(value.data, 3 * 1048576);
      jsonText(value.initialState);
    } catch {
      throw new AppError(503, 'invalid_resource');
    }
    return { handler, value, key: JSON.stringify([extensionId, ref]) };
  }

  async read(target: ConversationId, extensionId: string, ref: string) {
    const { value, key } = await this.resource(target, extensionId, ref);
    await this.ready();
    const saved = await this.source.database.get<{ state: string; revision: number }>(
      'SELECT state,revision FROM app_resource_states WHERE conversation_id=? AND ref=?',
      Number(target),
      key,
    );
    return {
      ref,
      data: value.data,
      state: saved ? (JSON.parse(saved.state) as Json) : value.initialState,
      revision: saved?.revision ?? 0,
    };
  }

  async save(
    target: ConversationId,
    extensionId: string,
    ref: string,
    state: unknown,
    expectedRevision: number,
  ): Promise<{ revision: number }> {
    const { handler, key } = await this.resource(target, extensionId, ref);
    if (!handler.validateState) throw new AppError(405, 'resource_read_only');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new AppError(400, 'invalid_revision');
    let text: string;
    try {
      text = jsonText(handler.validateState(state));
    } catch {
      throw new AppError(400, 'invalid_state');
    }
    await this.ready();
    return this.source.database.transaction(async (tx) => {
      let result = await tx.get<{ revision: number }>(
        'UPDATE app_resource_states SET state=?,revision=revision+1 WHERE conversation_id=? AND ref=? AND revision=? RETURNING revision',
        text,
        Number(target),
        key,
        expectedRevision,
      );
      if (!result && expectedRevision === 0)
        result = await tx.get<{ revision: number }>(
          'INSERT INTO app_resource_states(conversation_id,ref,state,revision) VALUES(?,?,?,1) ON CONFLICT DO NOTHING RETURNING revision',
          Number(target),
          key,
          text,
        );
      if (!result) throw new AppError(409, 'revision_conflict');
      return result;
    });
  }
}
