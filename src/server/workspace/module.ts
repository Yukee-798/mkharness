import type { ConversationId, Harness, Tx, TaskId } from '@earendil-works/pi-durable';
import { z } from 'zod';
import { AppError } from '../../shared/contracts';
import { canonicalJson, type Json } from '../../shared/json';
import {
  workspaceCommandSchema,
  referenceSchema,
  type WorkspaceCommand,
  type WorkspaceReference,
  type FrozenWorkspaceReference,
  type WorkspaceReceipt,
  type WorkspaceSnapshot,
} from '../../shared/workspace';
import {
  WorkspaceDoc,
  WorkspaceReceipts,
  WorkspaceSelections,
  type WorkspaceState,
  type Edit,
} from './documents';
import { BG } from '../chat/context';
import { scenarioRegistry } from '../../scenarios/server';
import type { WorkspaceIdentity, WorkspaceHandlerContext } from './types';
import type { ImageJobCapability } from '../../extensions/images/runtime';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export class WorkspaceModule {
  private handlers;
  constructor(
    readonly identity: WorkspaceIdentity,
    private pi: () => Promise<Harness>,
    private images: () => Promise<ImageJobCapability | undefined>,
    private watermark: () => Promise<number>,
    private registry = scenarioRegistry,
  ) {
    this.handlers = this.registry.scene(identity.kind).commands;
  }
  async read(query: string, input: Json = {}, cursor?: string): Promise<Json> {
    const pi = await this.pi();
    if (query === 'snapshot') {
      if (cursor) throw new AppError(400, 'invalid_cursor');
      const inspection = await pi.inspect(BG);
      const blocked = new Set(
        inspection.tasks
          .filter((task) => task.state.kind === 'blocked')
          .map((task) => Number(task.record.id)),
      );
      // Read through one native commit for a coherent snapshot; watermark is sampled
      // before the read, so a race may cause an extra refresh, never a missed update.
      const watermark = await this.watermark();
      return pi.commit(async (tx) => {
        const state = await tx.doc(WorkspaceDoc);
        const operations = [];
        for (const op of Object.values(state.operations)) {
          const task = await tx.task(op.taskId as TaskId);
          const status =
            op.status === 'pending' && blocked.has(op.taskId)
              ? 'blocked'
              : op.status === 'pending' && (!task || task.state.status === 'terminal')
                ? 'failed'
                : op.status;
          operations.push({
            ...op,
            status,
            ...(status === 'blocked' ? { code: 'task_definition_unavailable' } : {}),
            ...(status === 'failed' && !op.code
              ? { code: task ? 'task_stopped_or_unavailable' : 'task_missing' }
              : {}),
          });
        }
        return copy({
          ...this.identityPublic(),
          watermark,
          objects: Object.values(state.objects),
          assets: Object.values(state.assets).map(({ prefix: _prefix, ...asset }) => asset),
          operations,
          canUndo: !!state.undo.length,
          canRedo: !!state.redo.length,
        } satisfies WorkspaceSnapshot);
      }, BG) as Promise<unknown> as Promise<Json>;
    }
    if (query === 'operation') {
      const { id } = z.object({ id: z.string() }).strict().parse(input);
      const snapshot = (await this.read('snapshot')) as unknown as WorkspaceSnapshot;
      const operation = snapshot.operations.find((op) => op.id === id);
      if (!operation) throw new AppError(404, 'operation_not_found');
      return operation;
    }
    if (query === 'object') {
      const { id } = z.object({ id: z.string() }).strict().parse(input);
      const state = await pi.snapshot(WorkspaceDoc, BG),
        object = state?.objects[id];
      if (!object) throw new AppError(404, 'object_not_found');
      return copy(object);
    }
    const read = this.registry.scene(this.identity.kind).queries[query];
    if (read) return read(input, { pi, identity: this.identity, ...(cursor ? { cursor } : {}) });
    throw new AppError(404, 'workspace_query_unavailable');
  }
  private identityPublic() {
    return {
      scenarioId: this.identity.scenarioId,
      workspaceId: this.identity.workspaceId,
      kind: this.identity.kind,
    };
  }
  async execute(
    command: WorkspaceCommand,
    target: ConversationId,
    actor: 'user' | 'agent',
    frozen?: readonly FrozenWorkspaceReference[],
  ) {
    const pi = await this.pi();
    return pi.commit((tx) => this.executeTx(tx, command, target, actor, frozen), BG);
  }
  async executeTx(
    tx: Tx,
    raw: WorkspaceCommand,
    target: ConversationId,
    actor: 'user' | 'agent',
    frozen?: readonly FrozenWorkspaceReference[],
    runId?: string,
  ): Promise<WorkspaceReceipt> {
    const command = workspaceCommandSchema.parse(raw);
    const hash = canonicalJson(command);
    const receiptKey = `${actor}:${command.requestId}`;
    // The receipt keeps only a digest; source and large input never duplicate here.
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hash))),
    ]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const receipt = await tx.doc(WorkspaceReceipts, receiptKey, {
      hash: digest,
      result: { status: 'committed', objectIds: [] },
    });
    if (receipt.hash !== digest) throw new AppError(409, 'request_conflict');
    const state = await tx.doc(WorkspaceDoc);
    // A stable completed marker is a field in the receipt, not business-state scans.
    if ('completed' in receipt && receipt.completed === true) return copy(receipt.result);
    const guard =
      runId && frozen?.length
        ? await tx.doc(WorkspaceSelections, runId, { refs: [...frozen], started: false })
        : undefined;
    if (guard) this.validateSelection(state, guard.refs);
    else if (frozen) this.validateSelection(state, frozen);
    const before = copy(state.objects);
    const changes = new Set<string>();
    const context: WorkspaceHandlerContext = {
      tx,
      state,
      requestId: command.requestId,
      nativeConversationId: target,
      identity: this.identity,
      images: await this.images(),
      require(id, type) {
        const object = state.objects[id];
        if (!object || (type && object.type !== type)) throw new AppError(404, 'object_not_found');
        return object;
      },
      expect(id) {
        if (command.expected[id] === undefined)
          throw new AppError(409, 'object_precondition_required', '请刷新后重试，操作需要对象版本');
        if (state.objects[id]?.version !== command.expected[id])
          throw new AppError(409, 'workspace_conflict', '内容已更新，请重新选择后再试');
      },
      put(object, contentChanged = true) {
        if (
          !state.objects[object.id] &&
          (Object.keys(state.objects).length >= 200 || Object.keys(state.clocks).length >= 10000)
        )
          throw new AppError(409, 'workspace_capacity');
        const previous = state.objects[object.id],
          version = (state.clocks[object.id] ?? 0) + 1;
        const result = {
          ...copy(object),
          version,
          contentVersion: contentChanged ? version : (previous?.contentVersion ?? version),
        };
        state.clocks[object.id] = version;
        state.objects[object.id] = result;
        changes.add(object.id);
        return result;
      },
      remove(id) {
        delete state.objects[id];
        state.clocks[id] = (state.clocks[id] ?? 0) + 1;
        changes.add(id);
      },
    };
    let result: WorkspaceReceipt;
    if (command.name === 'workspace.undo' || command.name === 'workspace.redo') {
      if (actor !== 'user') throw new AppError(403, 'operation_forbidden');
      // Undo guards only affected objects. Unrelated task completion cannot block it.
      const from = command.name.endsWith('undo') ? state.undo : state.redo,
        to = command.name.endsWith('undo') ? state.redo : state.undo;
      const saved = from.pop();
      if (!saved) throw new AppError(409, 'nothing_to_undo');
      // User history never rewinds native tasks. Normalize both snapshots using
      // the pack's authoritative results, including history saved before completion.
      const restore = (objects: Edit['before']) =>
        Object.fromEntries(
          Object.entries(objects).map(([id, object]) => [
            id,
            object &&
              this.registry
                .scene(this.identity.kind)
                .packs.reduce(
                  (value, pack) => pack.restoreObject?.(value, state) ?? value,
                  copy(object),
                ),
          ]),
        );
      const edit = { before: restore(saved.before), after: restore(saved.after) };
      for (const [id, expected] of Object.entries(edit.after)) {
        if (
          canonicalJson(
            state.objects[id] ? { ...state.objects[id], version: 0, contentVersion: 0 } : null,
          ) !== canonicalJson(expected ? { ...expected, version: 0, contentVersion: 0 } : null)
        )
          throw new AppError(409, 'undo_conflict', '对象已有后续修改，无法撤销此操作');
      }
      const reverse: Edit = { before: {}, after: {} };
      for (const [id, old] of Object.entries(edit.before)) {
        reverse.before[id] = copy(state.objects[id] ?? null);
        if (old)
          context.put(old, edit.before[id]?.contentVersion !== edit.after[id]?.contentVersion);
        else context.remove(id);
        reverse.after[id] = copy(state.objects[id] ?? null);
      }
      to.push(reverse);
      result = { status: 'committed', objectIds: [...changes] };
    } else {
      const handler = this.handlers[command.name];
      if (!handler || (actor === 'agent' && !handler.model))
        throw new AppError(404, 'workspace_command_unavailable');
      const value = await handler.invoke(command.input, context);
      result = { status: value.operationId ? 'accepted' : 'committed', ...value };
      if (handler.undoable && changes.size) {
        state.undo.push({
          before: Object.fromEntries([...changes].map((id) => [id, before[id] ?? null])),
          after: Object.fromEntries(
            [...changes].map((id) => [id, copy(state.objects[id] ?? null)]),
          ),
        });
        state.undo = state.undo.slice(-30);
        state.redo = [];
      }
    }
    if (guard)
      guard.refs = guard.refs
        .filter((ref) => state.objects[ref.objectId])
        .map((ref) => ({ ...ref, contentVersion: state.objects[ref.objectId].contentVersion }));
    receipt.result = result;
    receipt.completed = true;
    return copy(result);
  }
  validateSelection(
    state: Readonly<WorkspaceState>,
    refs: readonly WorkspaceReference[],
  ): FrozenWorkspaceReference[] {
    return refs.map((ref) => {
      const object = state.objects[ref.objectId];
      if (!object || object.contentVersion !== ref.contentVersion)
        throw new AppError(409, 'workspace_selection_conflict', '引用内容已更新或删除，请重新选择');
      return {
        ...ref,
        title: object.title,
        summary: String(object.data.text ?? object.title).slice(0, 1500),
      };
    });
  }
  async freeze(tx: Tx, refs: readonly WorkspaceReference[], runId: string) {
    z.array(referenceSchema).max(20).parse(refs);
    const frozen = this.validateSelection(await tx.doc(WorkspaceDoc), refs);
    await tx.doc(WorkspaceSelections, runId, { refs: frozen, started: false });
    return frozen;
  }
  async begin(runId: string, refs: readonly WorkspaceReference[]) {
    const pi = await this.pi();
    await pi.commit(async (tx) => {
      const saved = await tx.doc(WorkspaceSelections, runId, { refs: [], started: false });
      if (saved.started) return;
      this.validateSelection(await tx.doc(WorkspaceDoc), refs);
      saved.started = true;
    }, BG);
  }
  async validate(refs: readonly WorkspaceReference[]) {
    const pi = await this.pi(),
      state = await pi.snapshot(WorkspaceDoc, BG);
    if (!state && refs.length) throw new AppError(409, 'workspace_selection_conflict');
    return state ? this.validateSelection(state, refs) : [];
  }
  async asset(id: string) {
    const state = await (await this.pi()).snapshot(WorkspaceDoc, BG),
      asset = state?.assets[id];
    if (!asset) throw new AppError(404, 'asset_not_found');
    return asset;
  }
}
