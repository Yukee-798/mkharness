export type SkillFile = {
  path: string;
  kind: 'reference' | 'script' | 'asset' | 'file';
  size: number;
  encoding: 'text' | 'base64';
  sha256: string;
};
export type SkillPreview = {
  name: string;
  description: string;
  body: string;
  compatibility?: string;
  license?: string;
  allowedTools?: string;
  version: string;
  files: SkillFile[];
  warnings: string[];
};
export type SkillView = Omit<SkillPreview, 'body' | 'files'> & {
  id: string;
  enabled: boolean;
  revision: number;
  updatedAt: number;
};
export type SkillBinding = Pick<SkillView, 'id' | 'name' | 'description' | 'version'>;
export const SKILL_LIMITS = {
  upload: 1024 * 1024,
  expanded: 2 * 1024 * 1024,
  file: 128 * 1024,
  files: 64,
  selected: 8,
} as const;
