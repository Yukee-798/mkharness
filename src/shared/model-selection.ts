export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export type ModelSelection = { provider: string; modelId: string; thinkingLevel: ThinkingLevel };
export type ModelCatalog = {
  models: { id: string; name: string; provider: string; thinkingLevels: ThinkingLevel[] }[];
  defaultSelection: ModelSelection;
};
export const thinkingLabels: Record<ThinkingLevel, string> = {
  off: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
};
