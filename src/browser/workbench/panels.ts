import type { ComponentType } from 'react';
import type { Json } from '../../shared/json';
import type { RunCommand } from '../../shared/contracts';

export type ConversationPort = {
  userId: string;
  chatId: string;
  nativeTarget: number;
  submit: (text: string, source?: RunCommand['source']) => Promise<void>;
};
export type PanelProps<T = Json> = {
  target: T;
  visible: boolean;
  conversation?: ConversationPort;
};
export type WorkbenchPanelDefinition = {
  scope: 'conversation' | 'workspace';
  parse: (value: unknown) => Json;
  key: (target: Json) => string;
  title: (target: Json) => string;
  Content: ComponentType<PanelProps>;
  /** Opt in to restoring a small, credential-free resource reference. */
  restore?: (target: Json) => Json | null;
};
export function defineWorkbenchPanel<T extends Json>(definition: {
  scope: WorkbenchPanelDefinition['scope'];
  parse: (value: unknown) => T;
  key: (target: T) => string;
  title: (target: T) => string;
  Content: ComponentType<PanelProps<T>>;
  restore?: (target: T) => Json | null;
}): WorkbenchPanelDefinition {
  return {
    scope: definition.scope,
    parse: definition.parse,
    key: (target) => definition.key(target as T),
    title: (target) => definition.title(target as T),
    Content: definition.Content as ComponentType<PanelProps>,
    ...(definition.restore ? { restore: (target: Json) => definition.restore!(target as T) } : {}),
  };
}
export type PanelRequest = {
  type: string;
  target: Json;
  activation: 'explicit' | 'suggested';
};
export type PanelSelection = {
  type: string;
  target: Json;
  key: string;
  chatId: string | null;
};
export type OpenPanelResult =
  { ok: true } | { ok: false; reason: 'unavailable' | 'invalid_target' | 'conversation_required' };
