import { ChatFixture as ChatSession } from './chat-fixture';
import { fixtureModels } from '../fixture-model';
export class BYOKProbe extends ChatSession {
  protected override async credentials() {
    return new (await import('../../src/server/models/credentials')).ModelCredentials(
      this.env,
      (await this.actor()).ownerId,
    );
  }
  protected override models() {
    const models = fixtureModels(),
      provider = models.getProvider('fixture')!;
    const removed = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name='test_removed_model'")
      .toArray().length
      ? String(this.ctx.storage.sql.exec('SELECT id FROM test_removed_model').one().id)
      : undefined;
    const record = (model: any, context: any, options: any) => {
      this.ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS test_byok(model TEXT,version TEXT,base_url TEXT)',
      );
      this.ctx.storage.sql.exec(
        'INSERT INTO test_byok VALUES(?,?,?)',
        model.id,
        options.apiKey?.split('-').at(-1) ?? 'missing',
        model.baseUrl,
      );
      if (options.cacheRetention === 'none') {
        this.ctx.storage.sql.exec(
          'CREATE TABLE IF NOT EXISTS test_byok_summary(model TEXT,version TEXT,base_url TEXT)',
        );
        this.ctx.storage.sql.exec(
          'INSERT INTO test_byok_summary VALUES(?,?,?)',
          model.id,
          options.apiKey?.split('-').at(-1) ?? 'missing',
          model.baseUrl,
        );
      }
      return provider.streamSimple(model, context, options);
    };
    models.setProvider({
      ...provider,
      getModels: () => provider.getModels().filter((m) => m.id !== removed),
      stream: record,
      streamSimple: record,
    });
    return models;
  }
  compactions() {
    return this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name='test_byok_summary'")
      .toArray().length
      ? this.ctx.storage.sql.exec('SELECT * FROM test_byok_summary').toArray()
      : [];
  }
  calls() {
    return this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name='test_byok'")
      .toArray().length
      ? this.ctx.storage.sql.exec('SELECT * FROM test_byok').toArray()
      : [];
  }
}
