import { AppError } from '../../shared/contracts';
import type { QueueDraft } from '../../shared/queue';
import {
  InboxDoc,
  type Harness,
  type ConversationId,
  type SubmissionId,
} from '@earendil-works/pi-durable';
import { BG } from './context';
import { QueueEdits, UnclaimedQueueEdits, admissionKey, type QueueEditReceipt } from './documents';

export const QUEUE_EDIT_RETENTION_MS = 24 * 60 * 60_000;
const MAX_UNCLAIMED_EDITS = 32;

/** Durable transfer receipts. The native Inbox remains the only executable queue. */
export class QueueEditTransfers {
  constructor(
    private pi: Harness,
    private withdrawn: (key: string) => Promise<void>,
  ) {}
  async edit(target: ConversationId, runId: string): Promise<QueueDraft | undefined> {
    const key = admissionKey(target, runId);
    let receipt = await this.pi.snapshot(QueueEdits, key, BG);
    if (!receipt) {
      await this.maintenance();
      receipt = await this.pi.commit(async (tx) => {
        const submission = await tx.submissionByRequest(target, runId);
        if (!submission || submission.type !== 'input') throw new AppError(404, 'run_not_found');
        if (submission.status !== 'queued') throw new AppError(409, 'queue_item_started');
        const inbox = await tx.doc(InboxDoc, target);
        const item = inbox.items.find((entry) => entry.id === submission.id);
        if (!item || item.mode === 'write') throw new AppError(409, 'queue_item_started');
        const command = (
          item.entry?.data as unknown as { request?: { runId: string } & QueueDraft }
        )?.request;
        if (!command) throw new AppError(503, 'queue_input_missing');
        const { runId: _id, ...draft } = command;
        const unclaimed = await tx.doc(UnclaimedQueueEdits);
        if (unclaimed.keys.length >= MAX_UNCLAIMED_EDITS)
          throw new AppError(429, 'queue_edit_limit');
        const seed: QueueEditReceipt = {
          submissionId: Number(submission.id),
          conversationId: Number(target),
          runId,
          state: 'prepared',
          expiresAt: Date.now() + QUEUE_EDIT_RETENTION_MS,
          draft: JSON.stringify(draft),
        };
        const saved = await tx.doc(QueueEdits, key, seed);
        if (!unclaimed.keys.includes(key)) unclaimed.keys.push(key);
        return JSON.parse(JSON.stringify(saved)) as QueueEditReceipt;
      }, BG);
    }
    return this.finish(key, receipt);
  }
  async existing(target: ConversationId, runId: string) {
    const key = admissionKey(target, runId),
      receipt = await this.pi.snapshot(QueueEdits, key, BG);
    if (!receipt) return;
    const draft = await this.finish(key, receipt);
    return draft ? { draft } : {};
  }
  private async finish(
    key: string,
    receipt: Readonly<QueueEditReceipt>,
  ): Promise<QueueDraft | undefined> {
    if (receipt.state === 'acknowledged') return undefined;
    if (receipt.state === 'started') throw new AppError(409, 'queue_item_started');
    if (receipt.state === 'expired') throw new AppError(410, 'queue_edit_expired');
    if (receipt.state === 'prepared') {
      const target = receipt.conversationId as ConversationId;
      const outcome = await this.pi.abortSubmission(
        receipt.submissionId as SubmissionId,
        BG,
        target,
      );
      const submission = await this.pi.commit(
        (tx) => tx.submissionByRequest(target, receipt.runId),
        BG,
      );
      if (
        outcome !== 'aborted' &&
        !(
          submission?.type === 'input' &&
          submission.status === 'unanswered' &&
          !submission.entry &&
          submission.reason === 'aborted'
        )
      ) {
        await this.settle(key, 'started');
        throw new AppError(409, 'queue_item_started');
      }
      await this.withdrawn(key);
      await this.pi.commit(async (tx) => {
        const saved = await tx.doc(QueueEdits, key, receipt);
        saved.state = 'edited';
      }, BG);
    }
    if (receipt.expiresAt <= Date.now()) {
      await this.settle(key, 'expired');
      throw new AppError(410, 'queue_edit_expired');
    }
    if (!receipt.draft) throw new AppError(503, 'queue_draft_missing');
    return JSON.parse(receipt.draft) as QueueDraft;
  }
  private async settle(key: string, state: 'acknowledged' | 'expired' | 'started') {
    await this.pi.commit(async (tx) => {
      const receipt = await tx.doc(QueueEdits, key, null);
      receipt.state = state;
      delete receipt.draft;
      const unclaimed = await tx.doc(UnclaimedQueueEdits);
      unclaimed.keys = unclaimed.keys.filter((candidate) => candidate !== key);
    }, BG);
  }
  async acknowledge(target: ConversationId, runId: string) {
    const key = admissionKey(target, runId),
      receipt = await this.pi.snapshot(QueueEdits, key, BG);
    if (!receipt) throw new AppError(404, 'queue_edit_not_found');
    if (receipt.state === 'acknowledged' || receipt.state === 'expired')
      return { acknowledged: true };
    if (receipt.state !== 'edited') throw new AppError(409, 'queue_edit_not_ready');
    await this.settle(key, 'acknowledged');
    return { acknowledged: true };
  }
  async recover() {
    for (const key of (await this.pi.snapshot(UnclaimedQueueEdits, BG))?.keys ?? []) {
      const receipt = await this.pi.snapshot(QueueEdits, key, BG);
      if (receipt?.state === 'prepared') {
        try {
          await this.finish(key, receipt);
        } catch (error) {
          if (
            !(error instanceof AppError) ||
            !['queue_item_started', 'queue_edit_expired'].includes(error.code)
          )
            throw error;
        }
      }
    }
    return this.maintenance();
  }
  async pending(target: ConversationId) {
    const result: { runId: string; expiresAt: number }[] = [];
    for (const key of (await this.pi.snapshot(UnclaimedQueueEdits, BG))?.keys ?? []) {
      const receipt = await this.pi.snapshot(QueueEdits, key, BG);
      if (
        receipt &&
        receipt.conversationId === Number(target) &&
        (receipt.state === 'prepared' || receipt.state === 'edited') &&
        receipt.expiresAt > Date.now()
      )
        result.push({ runId: receipt.runId, expiresAt: receipt.expiresAt });
    }
    return result;
  }
  async maintenance() {
    let next: number | undefined;
    for (const key of (await this.pi.snapshot(UnclaimedQueueEdits, BG))?.keys ?? []) {
      const receipt = await this.pi.snapshot(QueueEdits, key, BG);
      if (!receipt) throw new AppError(503, 'queue_draft_missing');
      if (receipt.state === 'edited' && receipt.expiresAt <= Date.now())
        await this.settle(key, 'expired');
      else if (receipt.state === 'prepared') next = Math.min(next ?? Infinity, Date.now() + 1000);
      else if (receipt.state === 'edited') next = Math.min(next ?? Infinity, receipt.expiresAt);
    }
    return next;
  }
}
