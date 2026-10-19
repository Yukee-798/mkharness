import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { CreateAttachment } from '@assistant-ui/react';
import type { RunCommand } from '../../shared/contracts';
import { jsonEqual } from '../../shared/json';

export type DraftImage = { id: string; input: File | CreateAttachment };
export class ComposerDraft {
  private value = {
    text: '',
    source: undefined as RunCommand['source'],
    workspaceReferences: [] as NonNullable<RunCommand['workspaceReferences']>,
    config: undefined as RunCommand['config'],
    images: [] as DraftImage[],
    version: 0,
  };
  private listeners = new Set<() => void>();
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<typeof this.value>) {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) listener();
  }
  edit(text: string, source = text ? this.value.source : undefined) {
    this.update({ text, source, version: this.value.version + 1 });
  }
  setWorkspaceReferences(workspaceReferences: NonNullable<RunCommand['workspaceReferences']>) {
    if (!jsonEqual(workspaceReferences, this.value.workspaceReferences))
      this.update({
        workspaceReferences: structuredClone(workspaceReferences),
        version: this.value.version + 1,
      });
  }
  restore(draft: Pick<RunCommand, 'text' | 'source' | 'config' | 'workspaceReferences'>) {
    this.update({
      text: draft.text,
      source: draft.source,
      config: draft.config,
      workspaceReferences: structuredClone(draft.workspaceReferences ?? []),
      version: this.value.version + 1,
    });
  }
  setConfig(config: RunCommand['config']) {
    if (!jsonEqual(config ?? null, this.value.config ?? null)) this.update({ config });
  }
  setImages(images: DraftImage[]) {
    if (
      images.length !== this.value.images.length ||
      images.some((image, index) => image.id !== this.value.images[index]?.id)
    )
      this.update({ images });
  }
  removeImages(ids: ReadonlySet<string>) {
    this.update({ images: this.value.images.filter((image) => !ids.has(image.id)) });
  }
  clearText(version: number) {
    if (this.value.version === version)
      this.update({ text: '', source: undefined, workspaceReferences: [], version: version + 1 });
  }
}
export class ComposerDrafts {
  private records = new Map<string, ComposerDraft>();
  get(id: string) {
    let record = this.records.get(id);
    if (!record) {
      record = new ComposerDraft();
      this.records.set(id, record);
    }
    return record;
  }
  remove(id: string) {
    this.records.delete(id);
  }
}
const Context = createContext<ComposerDrafts | null>(null);
export function ComposerDraftsProvider({
  children,
  userId,
}: {
  children: ReactNode;
  userId?: string;
}) {
  const account = useMemo(() => ({ userId, drafts: new ComposerDrafts() }), [userId]);
  return <Context value={account.drafts}>{children}</Context>;
}
export const useComposerDrafts = () => useContext(Context);
export function useComposerDraft(id: string) {
  const store = useComposerDrafts();
  const [local] = useState(() => new ComposerDraft());
  return store?.get(id) ?? local;
}
