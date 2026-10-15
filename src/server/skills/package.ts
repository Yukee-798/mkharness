import { Unzip, UnzipInflate } from 'fflate';
import { parseDocument } from 'yaml';
import { AppError } from '../../shared/contracts';
import { jsonText, canonicalJson } from '../../shared/json';
import { SKILL_LIMITS, type SkillFile, type SkillPreview } from '../../shared/skills';

export const safeSkillPath = (path: string) =>
  path.length <= 300 &&
  !/^[a-zA-Z]:/.test(path) &&
  !path.includes('\\') &&
  [...path].every((c) => c.charCodeAt(0) >= 32) &&
  path.split('/').every((p) => p && p !== '.' && p !== '..');
export async function sha256(data: Uint8Array | string) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)),
    (v) => v.toString(16).padStart(2, '0'),
  ).join('');
}
export function parseInstructions(raw: string) {
  // The SDK public skills barrel imports its optional script runner at runtime.
  // Keep import validation independent; use its YAML format and the native Pi bridge below it.
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new AppError(400, 'invalid_skill_markdown');
  let data: Record<string, unknown>;
  try {
    const document = parseDocument(match[1]!, { uniqueKeys: true });
    if (document.errors.length) throw new Error('invalid frontmatter');
    data = document.toJS({ maxAliasCount: 20 });
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('invalid metadata');
  } catch {
    throw new AppError(400, 'invalid_skill_markdown');
  }
  const string = (key: string) => (typeof data[key] === 'string' ? data[key].trim() : undefined);
  const parsed = {
    name: string('name') ?? '',
    description: string('description') ?? '',
    body: match[2]!,
    ...(string('compatibility') ? { compatibility: string('compatibility') } : {}),
    ...(string('license') ? { license: string('license') } : {}),
    ...(string('allowed-tools') ? { allowedTools: string('allowed-tools') } : {}),
    ...(data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
      ? { metadata: data.metadata as Record<string, unknown> }
      : {}),
  };
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parsed.name) ||
    parsed.name.length > 64 ||
    !parsed.description ||
    parsed.description.length > 1024 ||
    !parsed.body.trim()
  )
    throw new AppError(400, 'invalid_skill_markdown');
  try {
    jsonText(parsed, SKILL_LIMITS.file * 2);
  } catch {
    throw new AppError(400, 'invalid_skill_markdown');
  }
  return parsed;
}
function archive(bytes: Uint8Array) {
  const files = new Map<string, Uint8Array>();
  let total = 0,
    count = 0;
  const unzip = new Unzip((file) => {
    if (++count > SKILL_LIMITS.files * 2 || !safeSkillPath(file.name.replace(/\/$/, '')))
      throw new AppError(400, 'invalid_skill_path');
    if (file.name.endsWith('/')) return;
    if (files.has(file.name) || (file.originalSize ?? 0) > SKILL_LIMITS.file)
      throw new AppError(400, 'invalid_skill_archive');
    files.set(file.name, new Uint8Array());
    const chunks: Uint8Array[] = [];
    let length = 0,
      done = false;
    file.ondata = (error, chunk, final) => {
      if (error) throw new AppError(400, 'invalid_skill_archive');
      length += chunk.length;
      total += chunk.length;
      if (length > SKILL_LIMITS.file || total > SKILL_LIMITS.expanded) {
        file.terminate();
        throw new AppError(413, 'skill_package_too_large');
      }
      chunks.push(chunk);
      if (final) {
        const value = new Uint8Array(length);
        let offset = 0;
        for (const part of chunks) {
          value.set(part, offset);
          offset += part.length;
        }
        files.set(file.name, value);
        done = true;
      }
    };
    file.start();
    // Completion is checked below after all archive bytes have been pushed.
    finished.push(() => done);
  });
  const finished: (() => boolean)[] = [];
  unzip.register(UnzipInflate);
  try {
    for (let i = 0; i < bytes.length; i += 4096)
      unzip.push(bytes.subarray(i, i + 4096), i + 4096 >= bytes.length);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(400, 'invalid_skill_archive');
  }
  if (!finished.length || finished.some((done) => !done()))
    throw new AppError(400, 'invalid_skill_archive');
  return files;
}
export async function importSkill(
  bytes: Uint8Array,
  filename: string,
): Promise<{ preview: SkillPreview; files: Map<string, Uint8Array> }> {
  if (bytes.length > SKILL_LIMITS.upload) throw new AppError(413, 'skill_package_too_large');
  let files: Map<string, Uint8Array>;
  if (/\.zip$/i.test(filename)) files = archive(bytes);
  else if (/\.md$/i.test(filename)) files = new Map([['SKILL.md', bytes]]);
  else throw new AppError(400, 'skill_file_type');
  const roots = [...files.keys()].filter(
    (path) => path === 'SKILL.md' || path.endsWith('/SKILL.md'),
  );
  if (roots.length !== 1) throw new AppError(400, 'skill_package_requires_one_skill');
  const root = roots[0]!,
    prefix = root.slice(0, -'SKILL.md'.length);
  if ([...files.keys()].some((path) => !path.startsWith(prefix)))
    throw new AppError(400, 'invalid_skill_archive');
  files = new Map([...files].map(([path, data]) => [path.slice(prefix.length), data]));
  if (files.size > SKILL_LIMITS.files) throw new AppError(413, 'skill_package_too_large');
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(files.get('SKILL.md'));
  } catch {
    throw new AppError(400, 'invalid_skill_markdown');
  }
  const parsed = parseInstructions(raw);
  if (prefix && prefix.split('/').filter(Boolean).at(-1) !== parsed.name)
    throw new AppError(400, 'skill_directory_name_mismatch');
  const descriptors: SkillFile[] = [];
  for (const [path, data] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!safeSkillPath(path)) throw new AppError(400, 'invalid_skill_path');
    if (data.length > SKILL_LIMITS.file) throw new AppError(413, 'skill_package_too_large');
    let encoding: 'text' | 'base64' = 'text';
    try {
      if (new TextDecoder('utf-8', { fatal: true }).decode(data).includes('\0'))
        encoding = 'base64';
    } catch {
      encoding = 'base64';
    }
    descriptors.push({
      path,
      size: data.length,
      encoding,
      sha256: await sha256(data),
      kind:
        path.startsWith('scripts/') || /\.(py|sh|bash|js|mjs|ts|tsx|exe|wasm)$/i.test(path)
          ? 'script'
          : path.startsWith('references/')
            ? 'reference'
            : path.startsWith('assets/')
              ? 'asset'
              : 'file',
    });
  }
  const version = await sha256(canonicalJson(descriptors));
  const warnings: string[] = [];
  if (descriptors.some((f) => f.kind === 'script'))
    warnings.push('Scripts are stored as files and cannot be executed.');
  if (descriptors.some((f) => f.encoding === 'base64'))
    warnings.push('Binary assets are stored but cannot be read by the agent in this version.');
  if (parsed.compatibility || parsed.allowedTools)
    warnings.push(
      'Host requirements are informational. Tools and permissions must be configured separately.',
    );
  return { files, preview: { ...parsed, version, files: descriptors, warnings } };
}
