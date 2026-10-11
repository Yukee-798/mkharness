import { ACTION_STEPS, BuiltinActionType, isASTNode, type ParseResult } from '@openuidev/lang-core';
import { z } from 'zod';

export const UI_ACTIONS = {
  assistant: BuiltinActionType.ContinueConversation,
  link: BuiltinActionType.OpenUrl,
} as const;

export const UI_ACTION_RULE =
  'The host supports Action([@ToAssistant("message", "optional context")]) for an explicit agent request and Action([@OpenUrl("https://...")]) for opening a real source URL in a new browser tab without an agent request. Links must be complete HTTP or HTTPS URLs without credentials or control characters; other protocols and arbitrary business actions are unavailable. Native @Set, @Reset and @Run of the bound run_program Query remain local. URLs may come from variables or Each row expressions and are checked again on click. Never invent an action handler.';

export const actionParamsSchema = z
  .record(z.string(), z.json())
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 16384,
    'UI action context exceeds 16 KiB',
  );

export function actionParams(value: unknown) {
  const parsed = actionParamsSchema.safeParse(value ?? {});
  if (!parsed.success) throw new Error('此操作的上下文过大或格式不正确，请继续发送消息。');
  return parsed.data;
}

/** Navigation is a browser capability; generated content cannot choose another protocol. */
export function externalURL(value: unknown): string {
  const invalid = () => new Error('链接不可用，请使用不含账号信息的完整 HTTP 或 HTTPS 地址。');
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    value !== value.trim() ||
    !/^https?:\/\//i.test(value) ||
    value.includes('\\') ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw invalid();
  return url.href;
}

/** Inspect preserved SDK expressions, including hidden branches and Each templates. */
export function validateUIActions(parsed: ParseResult): void {
  const unavailable = () =>
    new Error('Unsupported UI action; use ToAssistant, OpenUrl or native local actions');
  const field = (value: unknown, name: string): unknown => {
    if (isASTNode(value))
      return value.k === 'Obj' ? value.entries.find(([key]) => key === name)?.[1] : undefined;
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)[name]
      : undefined;
  };
  const literal = (value: unknown): unknown => {
    if (!isASTNode(value)) return value;
    if (value.k === 'Str' || value.k === 'Num' || value.k === 'Bool') return value.v;
    if (value.k === 'Null') return null;
    return value;
  };
  const checkURL = (value: unknown) => {
    const known = literal(value);
    // Expressions such as $url and row.url are evaluated by the SDK at click time.
    if (!isASTNode(known)) externalURL(known);
  };
  const checkAction = (value: unknown): void => {
    if (isASTNode(value)) {
      if (value.k === 'Null') return;
      if (value.k === 'Ternary') {
        checkAction(value.then);
        checkAction(value.else);
        return;
      }
      if (value.k === 'Comp') {
        if (value.name === 'Action') {
          const steps = value.args[0];
          if (!steps || steps.k !== 'Arr') throw unavailable();
          steps.els.forEach((item) => checkAction(item));
          return;
        }
        if (Object.hasOwn(ACTION_STEPS, value.name)) {
          if (value.name === 'OpenUrl') checkURL(value.args[0]);
          return;
        }
      }
    }
    const type = literal(field(value, 'type'));
    // Legacy action objects and object steps are accepted by the installed SDK.
    if (type === UI_ACTIONS.link) {
      checkURL(field(value, 'url') ?? field(field(value, 'params'), 'url'));
    } else if (type !== UI_ACTIONS.assistant) {
      // Local steps use SDK expressions, whose targets/references the SDK validates.
      throw unavailable();
    }
  };
  const pending: unknown[] = [parsed.root],
    seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const node = value as Record<string, unknown>;
    if (node.type === 'element') {
      const action = field(node.props, 'action');
      if (action !== undefined && action !== null) checkAction(action);
    }
    if (isASTNode(value) && value.k === 'Comp') {
      if (value.name === 'Action') checkAction(value);
      const action = value.mappedProps?.action;
      if (action) checkAction(action);
    }
    for (const child of Object.values(node))
      if (child && typeof child === 'object') pending.push(child);
  }
}
