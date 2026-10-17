import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { english } from './messages';

export type Locale = 'en' | 'zh-CN';
export const localeStorageKey = 'mkharness.locale';
type Values = Record<string, string | number>;
const chinese: Record<string, string> = {
  Skills: '技能',
  'Import skill': '导入技能',
  'Update skill': '更新技能',
  'Skill file': '技能文件',
  'Loading skills…': '正在加载技能…',
  'No skills yet.': '尚未导入技能。',
  'Save skill': '保存技能',
  'Save new version': '保存新版本',
  'View skill': '查看技能',
  'Delete skill': '删除技能',
  Version: '版本',
  Compatibility: '兼容性',
  'Declared tools': '声明的工具',
  'Not executable': '不可执行',
  'Binary asset': '二进制资源',
  Loaded: '已加载',
  'Skills in this chat': '本聊天可用技能',
  'Skills for this chat': '选择本聊天的技能',
  'Import task guidance and reference files. Enabled skills are available in new chats; existing chats keep their versions.':
    '导入任务说明与参考文件。已启用技能用于新聊天，已有聊天保留原版本。',
  'Upload SKILL.md or a ZIP containing one skill. Scripts are not executed. Skills do not grant tool permissions.':
    '上传 SKILL.md 或仅包含一个技能的 ZIP。脚本不会执行，技能也不会授予工具权限。',
  'Skill instructions and bundled files': '技能说明与附带文件',
  'Remove this skill from your library. Existing chats retain their pinned versions and loaded instructions.':
    '从技能库移除此技能。已有聊天保留已绑定的版本及加载过的说明。',
  'Scripts are stored as files and cannot be executed.': '脚本仅作为文件保存，无法执行。',
  'Binary assets are stored but cannot be read by the agent in this version.':
    '二进制资源会保存，但本版 Agent 暂不支持读取。',
  'Host requirements are informational. Tools and permissions must be configured separately.':
    '运行环境声明仅供参考，工具与权限需要单独配置。',
  'The agent loads selected skills when relevant. Versions are fixed when this chat starts.':
    'Agent 会在任务相关时加载已选技能，聊天开始时固定版本。',
  'Could not refresh skills. Existing selections are kept; otherwise account defaults apply.':
    '暂时无法刷新技能列表。已有选择会保留，否则使用账号默认配置。',
  'Select at most 8 skills.': '最多选择 8 个技能。',
  skill_not_found: '技能不存在。',
  skill_revision_conflict: '技能已在其他页面更新，请刷新后重试。',
  invalid_skill_markdown: 'SKILL.md 需要有效的 name、description 和非空正文。',
  skill_package_too_large: '技能包过大。上传最多 1 MiB，解压后最多 2 MiB，单文件最多 128 KiB。',
  invalid_skill_path: '技能包包含无效路径。',
  invalid_skill_archive: '技能 ZIP 无效，或包含重复、超大的文件。',
  skill_package_requires_one_skill: '请上传仅包含一个 SKILL.md 的技能包。',
  skill_directory_name_mismatch: '技能目录名称须与 SKILL.md 中的 name 一致。',
  skill_file_type: '请上传 Markdown 文件或 ZIP 技能包。',
  duplicate_skill_name: '已有同名技能，请使用“更新技能”。',
  skill_name_changed: '更新时须保持技能名称不变。',
  skill_library_limit: '技能库最多保存 32 个技能。',
  skill_selection_limit: '新聊天最多启用 8 个技能，请调整选择。',
  skill_unavailable: '所选技能不可用或已停用，请重新选择。',
  skill_storage_unavailable: '技能文件存储未配置。',
  Connections: '连接',
  'MCP connections': 'MCP 连接',
  'Connect remote tools to your account. Enabled tools are available in new chats; existing chats keep their tool versions.':
    '将远程工具连接到你的账号。已启用工具用于新聊天，已有聊天保留原工具版本。',
  'Add connection': '添加连接',
  'Loading connections…': '正在加载连接…',
  'Connection name': '连接名称',
  'Server URL': '服务地址',
  Authentication: '授权方式',
  'Automatic OAuth': '自动 OAuth',
  'No authentication': '无需授权',
  'Bearer token': 'Bearer 令牌',
  'Advanced OAuth settings': '高级 OAuth 设置',
  'Only needed when the server requires a pre-registered OAuth client.':
    '仅当服务要求预先注册 OAuth 客户端时填写。',
  'Tools can send their arguments to this server. Connect only servers you trust. Credentials are encrypted on this deployment.':
    '工具调用会将参数发送给该服务。请仅连接你信任的服务；凭据在本部署中加密保存。',
  'Connecting…': '正在连接…',
  Connect: '连接',
  Cancel: '取消',
  'Authorization did not complete. Connect again to retry.': '授权未完成，请重新连接。',
  'A connection change is already in progress.': '连接正在更新，请稍候。',
  'This approval has expired.': '此确认请求已过期。',
  'Approved, running': '已允许，执行中',
  Denied: '已拒绝',
  Finished: '已完成',
  'No connections yet.': '尚未添加连接。',
  Enabled: '已启用',
  'Refresh tools': '刷新工具',
  Disconnect: '断开连接',
  Disabled: '禁用',
  'Ask every time': '每次询问',
  'Allow automatically': '允许自动调用',
  Disconnected: '已断开',
  Connecting: '正在连接',
  'Authorization required': '等待授权',
  Ready: '可用',
  'Reconnect required': '需要重新授权',
  'Connection failed': '连接失败',
  'Unsupported schema': '暂不支持此工具格式',
  'Future tool calls will be blocked. Chat history and records of uncertain remote operations will remain.':
    '后续工具调用将被阻止，聊天历史及结果待确认的操作记录会保留。',
  'Tools in this chat': '本聊天可用的连接',
  'Allow this tool call? The arguments below will be sent to this server.':
    '是否允许本次工具调用？下方参数将发送给该服务。',
  'Allow once': '允许一次',
  Reject: '拒绝',
  'The remote outcome is unknown. Check the external service before taking further action. This operation will not be replayed automatically.':
    '远端结果尚无法确认。请先到外部服务核实，本次操作不会自动重放。',

  queue_item_started: '这项任务已开始或结束，队列已刷新。',
  queue_edit_expired: '这份草稿已过期。',
  queue_edit_limit: '请先恢复待领取草稿，再编辑更多排队消息。',
  queue_edit_not_found: '这份草稿已不可用。',
  queue_edit_not_ready: '草稿尚未准备好，请重试。',
  reply_not_found: '原回答不可用，请重新打开当前聊天后再试。',
  reply_context_unavailable: '原始输入不可用，请重新发送问题。',
  关闭思考: '关闭',
  Today: '今天',
  Earlier: '更早',
  'Interactive answer': '交互式回答',
  删除说明: '“{title}”的历史和填写内容将被删除，当前任务会停止，排队任务会撤回。此操作无法撤销。',
  显示失败说明: '内容暂时无法显示：{error}。可继续发送消息，填写内容仍保留。',
};
export function translate(locale: Locale, message: string, values: Values = {}) {
  const messages = locale === 'en' ? english : chinese;
  const text = Object.hasOwn(messages, message) ? messages[message]! : message;
  return text.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
}
function readLocale(): Locale {
  try {
    return localStorage.getItem(localeStorageKey) === 'zh-CN' ? 'zh-CN' : 'en';
  } catch {
    return 'en';
  }
}
const LocaleContext = createContext({
  locale: 'en' as Locale,
  setLocale: (_locale: Locale) => {},
  t: (message: string, values?: Values) => translate('en', message, values),
});
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState<Locale>(readLocale);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === localeStorageKey || event.key === null) updateLocale(readLocale());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const value = useMemo(
    () => ({
      locale,
      setLocale(next: Locale) {
        updateLocale(next);
        try {
          localStorage.setItem(localeStorageKey, next);
        } catch {
          // Language switching still works when persistent browser storage is unavailable.
        }
      },
      t: (message: string, values?: Values) => translate(locale, message, values),
    }),
    [locale],
  );
  return <LocaleContext value={value}>{children}</LocaleContext>;
}
export function useLocale() {
  return useContext(LocaleContext);
}
