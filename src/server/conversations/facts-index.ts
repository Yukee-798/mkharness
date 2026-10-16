import {
  ROOT_CONVERSATION_ID,
  type Storage,
  type StorageWrite,
  type Cursor,
  type EntryRecord,
  type TaskId,
  type SubmissionId,
} from '@earendil-works/pi-durable';
import type { ProjectionContext } from '../extensions/contributions';
import { BG } from './context';

/** Derived locators only. Native records are always re-read through public Storage. */
export class ConversationFactsIndex {
  private native?: Storage;
  private preparing?: Promise<void>;
  constructor(private host: DurableObjectStorage) {
    host.sql.exec(
      'CREATE TABLE IF NOT EXISTS app_read_tasks(id INTEGER PRIMARY KEY,assistant INTEGER,kind TEXT NOT NULL,status TEXT NOT NULL)',
    );
    host.sql.exec(
      'CREATE INDEX IF NOT EXISTS app_read_tasks_assistant ON app_read_tasks(assistant)',
    );
    host.sql.exec('CREATE INDEX IF NOT EXISTS app_read_tasks_status ON app_read_tasks(status)');
    host.sql.exec(
      'CREATE TABLE IF NOT EXISTS app_read_submissions(id INTEGER PRIMARY KEY,entry INTEGER,answer INTEGER,request_id TEXT,status TEXT NOT NULL)',
    );
    host.sql.exec(
      'CREATE INDEX IF NOT EXISTS app_read_submissions_entry ON app_read_submissions(entry)',
    );
    host.sql.exec(
      'CREATE INDEX IF NOT EXISTS app_read_submissions_answer ON app_read_submissions(answer)',
    );
    host.sql.exec(
      'CREATE INDEX IF NOT EXISTS app_read_submissions_status ON app_read_submissions(status)',
    );
  }
  get ready() {
    return this.meta('read-index-v1') === 'done';
  }
  get revision() {
    return Number(this.meta('read-index-seq') ?? 0);
  }
  private meta(key: string) {
    return this.host.sql
      .exec<{ value: string }>('SELECT value FROM app_meta WHERE key=?', key)
      .toArray()[0]?.value;
  }
  private setMeta(key: string, value: string) {
    this.host.sql.exec(
      'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      value,
    );
  }
  /** Called inside the ownership-fenced native commit transaction. */
  committed(writes: readonly StorageWrite[], seq: number) {
    for (const write of writes) this.index(write, false);
    this.setMeta('read-index-seq', String(seq));
  }
  private index(write: StorageWrite, backfill: boolean) {
    if (write.type === 'task' && write.value.conversationId === ROOT_CONVERSATION_ID) {
      const task = write.value;
      const input = task.input;
      const assistant =
        input &&
        typeof input === 'object' &&
        !Array.isArray(input) &&
        typeof input.assistant === 'number'
          ? input.assistant
          : null;
      this.host.sql.exec(
        'INSERT INTO app_read_tasks(id,assistant,kind,status) VALUES(?,?,?,?) ON CONFLICT(id) ' +
          (backfill
            ? 'DO NOTHING'
            : 'DO UPDATE SET assistant=excluded.assistant,kind=excluded.kind,status=excluded.status'),
        Number(task.id),
        assistant,
        task.kind,
        task.state.status,
      );
    } else if (write.type === 'submission' && write.value.conversationId === ROOT_CONVERSATION_ID) {
      const item = write.value;
      this.host.sql.exec(
        'INSERT INTO app_read_submissions(id,entry,answer,request_id,status) VALUES(?,?,?,?,?) ON CONFLICT(id) ' +
          (backfill
            ? 'DO NOTHING'
            : 'DO UPDATE SET entry=excluded.entry,answer=excluded.answer,request_id=excluded.request_id,status=excluded.status'),
        Number(item.id),
        'entry' in item ? Number(item.entry) || null : null,
        'answer' in item ? Number(item.answer) || null : null,
        item.requestId ?? null,
        item.status,
      );
    }
  }
  prepare(native: Storage) {
    this.native = native;
    return (this.preparing ??= this.backfill(native).catch((error) => {
      this.preparing = undefined;
      throw error;
    }));
  }
  private async backfill(native: Storage) {
    if (this.ready) return;
    for (const kind of ['task', 'submission'] as const) {
      const key = 'read-index-v1-' + kind;
      const saved = this.meta(key);
      if (saved === 'done') continue;
      let cursor: Cursor | undefined = saved ? JSON.parse(saved) : undefined;
      do {
        const page =
          kind === 'task'
            ? await native.scanTasks(
                { conversationId: ROOT_CONVERSATION_ID, order: 'ascending' },
                100,
                cursor,
                BG,
              )
            : await native.scanSubmissions(
                { conversationId: ROOT_CONVERSATION_ID, order: 'ascending' },
                100,
                cursor,
                BG,
              );
        // New publications win if they raced an older bootstrap page.
        this.host.transactionSync(() => {
          for (const value of page.items) {
            if (kind === 'task')
              this.index(
                { type: 'task', value: value as Extract<StorageWrite, { type: 'task' }>['value'] },
                true,
              );
            else
              this.index(
                {
                  type: 'submission',
                  value: value as Extract<StorageWrite, { type: 'submission' }>['value'],
                },
                true,
              );
          }
          this.setMeta(key, page.next ? JSON.stringify(page.next) : 'done');
        });
        cursor = page.next;
      } while (cursor);
    }
    this.setMeta('read-index-v1', 'done');
  }
  /** The earlier input of every reply intersecting a page belongs to that page. */
  lowerBound(min: number, max: number) {
    return (
      this.host.sql
        .exec<{ entry: number | null }>(
          'SELECT MIN(entry) AS entry FROM app_read_submissions WHERE answer>=? AND answer<=?',
          min,
          max,
        )
        .toArray()[0]?.entry ?? min
    );
  }
  async facts(
    entries: readonly EntryRecord[],
    extraTasks: readonly number[] = [],
  ): Promise<ProjectionContext> {
    if (!this.native) throw new Error('Read index not attached');
    const min = Number(entries[0]?.id ?? 0),
      max = Number(entries.at(-1)?.id ?? 0);
    const taskIds = new Set(extraTasks);
    for (const entry of entries)
      if (entry.byTaskId !== undefined) taskIds.add(Number(entry.byTaskId));
    for (const { id } of this.host.sql
      .exec<{ id: number }>(
        'SELECT id FROM app_read_tasks WHERE assistant BETWEEN ? AND ?',
        min,
        max,
      )
      .toArray())
      taskIds.add(id);
    for (const { id } of this.host.sql
      .exec<{ id: number }>(
        'SELECT id FROM app_read_tasks WHERE status IN (?,?,?)',
        'pending',
        'running',
        'waiting',
      )
      .toArray())
      taskIds.add(id);
    const tasks = (await Promise.all([...taskIds].map((id) => this.native!.task(id as TaskId, BG))))
      .filter((task) => task?.conversationId === ROOT_CONVERSATION_ID)
      .filter((task) => task !== undefined);
    const submissionIds = new Set(
      [
        ...this.host.sql
          .exec<{ id: number }>(
            'SELECT id FROM app_read_submissions WHERE entry BETWEEN ? AND ?',
            min,
            max,
          )
          .toArray(),
        ...this.host.sql
          .exec<{ id: number }>(
            'SELECT id FROM app_read_submissions WHERE answer BETWEEN ? AND ?',
            min,
            max,
          )
          .toArray(),
        ...this.host.sql
          .exec<{ id: number }>(
            'SELECT id FROM app_read_submissions WHERE status IN (?,?)',
            'queued',
            'placed',
          )
          .toArray(),
      ].map((row) => row.id),
    );
    const submissions = (
      await Promise.all(
        [...submissionIds].map((id) => this.native!.submission(id as SubmissionId, BG)),
      )
    )
      .filter((item) => item?.conversationId === ROOT_CONVERSATION_ID)
      .filter((item) => item !== undefined);
    return { entries, tasks, submissions };
  }
}
