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

export function resolveModelSelection(
  catalog: ModelCatalog,
  value?: ModelSelection,
): ModelSelection {
  const model = catalog.models.find(
    (m) => m.provider === value?.provider && m.id === value?.modelId,
  );
  if (!value || !model) return catalog.defaultSelection;
  return model.thinkingLevels.includes(value.thinkingLevel)
    ? value
    : { ...value, thinkingLevel: model.thinkingLevels[0]! };
}
