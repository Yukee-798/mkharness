import type { ModelRef } from '@earendil-works/pi-durable';
import { storedRequestSchema, type StoredRequest } from '../../shared/contracts';
import { executionProviderId } from '../models/execution';

/** Compact immutable receipt metadata; original request bodies remain untouched. */
export class ExecutionBindings {
  private preparing?: Promise<void>;
  private initialized = false;
  constructor(private host: DurableObjectStorage) {
    host.sql.exec(
      'CREATE TABLE IF NOT EXISTS app_request_execution(id TEXT PRIMARY KEY,provider TEXT NOT NULL,model_id TEXT NOT NULL,execution TEXT NOT NULL)',
    );
    host.sql.exec(
      'CREATE INDEX IF NOT EXISTS app_request_execution_model ON app_request_execution(provider,model_id)',
    );
    host.sql.exec('CREATE INDEX IF NOT EXISTS app_requests_accepted ON app_requests(accepted)');
  }
  async record(id: string, execution: StoredRequest['execution']) {
    const provider = await executionProviderId(execution);
    this.host.sql.exec(
      'INSERT INTO app_request_execution(id,provider,model_id,execution) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING',
      id,
      provider,
      execution.modelId,
      JSON.stringify(execution),
    );
    if (this.initialized)
      this.host.sql.exec(
        'INSERT INTO app_meta(key,value) SELECT ?,CAST(rowid AS TEXT) FROM app_requests WHERE id=? ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)',
        'execution-index-v1',
        id,
      );
  }
  private prepare() {
    return (this.preparing ??= (async () => {
      let position = Number(
        this.host.sql
          .exec<{ value: string }>('SELECT value FROM app_meta WHERE key=?', 'execution-index-v1')
          .toArray()[0]?.value ?? 0,
      );
      while (true) {
        const rows = this.host.sql
          .exec<{ rowid: number; id: string; payload: string }>(
            'SELECT rowid,id,payload FROM app_requests WHERE rowid>? ORDER BY rowid LIMIT 100',
            position,
          )
          .toArray();
        if (!rows.length) {
          this.initialized = true;
          return;
        }
        for (const row of rows)
          await this.record(row.id, storedRequestSchema.parse(JSON.parse(row.payload)).execution);
        position = rows.at(-1)!.rowid;
        this.host.sql.exec(
          'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          'execution-index-v1',
          String(position),
        );
      }
    })().catch((error) => {
      this.preparing = undefined;
      throw error;
    }));
  }
  async restore(refs: readonly ModelRef[]) {
    await this.prepare();
    const rows = new Map<string, { execution: string; accepted: number }>();
    for (const ref of refs) {
      const row = this.host.sql
        .exec<{ execution: string }>(
          'SELECT execution FROM app_request_execution WHERE provider=? AND model_id=? LIMIT 1',
          ref.provider,
          ref.modelId,
        )
        .toArray()[0];
      if (row) rows.set(JSON.stringify(ref), { ...row, accepted: 1 });
    }
    for (const row of this.host.sql
      .exec<{ id: string; execution: string; accepted: number }>(
        'SELECT e.id,e.execution,r.accepted FROM app_requests r JOIN app_request_execution e ON e.id=r.id WHERE r.accepted=0',
      )
      .toArray())
      rows.set(row.id, row);
    return [...rows.values()].map((row) => ({
      stored: { execution: JSON.parse(row.execution) as StoredRequest['execution'] },
      accepted: row.accepted,
    }));
  }
  latest() {
    const row = this.host.sql
      .exec<{ execution: string }>(
        'SELECT e.execution FROM app_requests r JOIN app_request_execution e ON e.id=r.id WHERE r.accepted<>-1 ORDER BY r.rowid DESC LIMIT 1',
      )
      .toArray()[0];
    return row ? (JSON.parse(row.execution) as StoredRequest['execution']) : undefined;
  }
}
