import { ApiError } from '../api';
import { workspaceChinese } from '../app/workspace-messages';

/** Keep a message key in state so an existing error follows language changes. */
export function workspaceError(error: unknown) {
  if (error instanceof ApiError && Object.hasOwn(workspaceChinese, error.code)) return error.code;
  return error instanceof Error ? error.message : 'request_failed';
}
