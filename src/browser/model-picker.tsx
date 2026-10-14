import { useLocale } from './locale';
import { Bot } from 'lucide-react';
import {
  thinkingLabels,
  type ModelCatalog,
  type ModelSelection,
  type ThinkingLevel,
} from '../shared/model-selection';
import {
  ModelSelectorRoot,
  ModelSelectorTrigger,
  ModelSelectorValue,
  ModelSelectorContent,
  ModelSelectorSearch,
  ModelSelectorList,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorEmpty,
  ModelSelectorEffort,
} from './model-selector';

/** Standalone assistant-ui selector: the host submits settings over its durable HTTP path. */
export function ModelPicker({
  catalog,
  value,
  onChange,
  disabled,
}: {
  catalog: ModelCatalog;
  value: ModelSelection;
  onChange: (selection: ModelSelection) => void;
  disabled?: boolean;
}) {
  const { t } = useLocale();
  const searchable = catalog.models.length > 5;
  return (
    <ModelSelectorRoot
      models={catalog.models.map((model) => ({
        id: JSON.stringify([model.provider, model.id]),
        name: model.name,
        keywords: [model.provider],
        icon: <Bot className="size-4" />,
        efforts:
          model.thinkingLevels.length > 1
            ? model.thinkingLevels.map((id) => ({
                id,
                name: t(id === 'off' ? '关闭思考' : thinkingLabels[id]),
              }))
            : undefined,
      }))}
      value={JSON.stringify([value.provider, value.modelId])}
      effort={value.thinkingLevel}
      onValueChange={(modelId) => {
        const model = catalog.models.find((m) => JSON.stringify([m.provider, m.id]) === modelId)!;
        const thinkingLevel = model.thinkingLevels.includes(value.thinkingLevel)
          ? value.thinkingLevel
          : model.thinkingLevels.includes(catalog.defaultSelection.thinkingLevel)
            ? catalog.defaultSelection.thinkingLevel
            : (model.thinkingLevels.find((level) => level !== 'off') ?? 'off');
        onChange({ provider: model.provider, modelId: model.id, thinkingLevel });
      }}
      onEffortChange={(level) => onChange({ ...value, thinkingLevel: level as ThinkingLevel })}
    >
      <ModelSelectorTrigger
        variant="ghost"
        size="sm"
        aria-label={t('模型与思考强度')}
        disabled={disabled}
        className="min-w-0 max-w-full"
      >
        <ModelSelectorValue />
      </ModelSelectorTrigger>
      <ModelSelectorContent
        align="start"
        side="top"
        searchable={searchable}
        className="w-80 max-w-[calc(100vw-2rem)] rounded-xl"
      >
        {searchable && <ModelSelectorSearch placeholder={t('搜索模型…')} />}
        <ModelSelectorList>
          <ModelSelectorEmpty>{t('没有匹配的模型')}</ModelSelectorEmpty>
          <ModelSelectorGroup>
            {catalog.models.map((model) => (
              <ModelSelectorItem
                key={JSON.stringify([model.provider, model.id])}
                model={{
                  id: JSON.stringify([model.provider, model.id]),
                  name: model.name,
                  keywords: [model.provider],
                  icon: <Bot className="size-4" />,
                }}
              />
            ))}
          </ModelSelectorGroup>
        </ModelSelectorList>
        <ModelSelectorEffort
          label={t('思考强度')}
          className="[&_[role=radiogroup]]:flex-wrap [&_[role=radiogroup]]:justify-end"
        />
      </ModelSelectorContent>
    </ModelSelectorRoot>
  );
}
