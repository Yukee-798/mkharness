import type { SkillSource, SkillContent } from 'agents/skills';

export function exampleSkillSource(): SkillSource {
  const content: SkillContent = {
    name: 'source-comparison',
    description: 'Compare public sources and explain uncertainties.',
    body: 'Use only enabled read_web/search_web tools. Keep source URLs and dates. Separate verified facts from assumptions. Consult references/checklist.md before presenting a comparison. This guidance grants no additional tools or permissions.',
    resources: [{ path: 'references/checklist.md', kind: 'reference' }],
  };
  return {
    id: 'app-guides',
    fingerprint: 'remote-research-v1',
    list: async () => [content],
    load: async (name) => (name === content.name ? content : null),
    readResource: async (name, path) =>
      name === content.name && path === 'references/checklist.md'
        ? {
            path,
            kind: 'reference',
            content:
              'Check dates, source scope and conflicting claims. Cite the original URLs. State missing evidence.',
          }
        : null,
  };
}
