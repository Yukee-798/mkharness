/** Versioned dependencies are part of the saved report, never inferred from HTML. */
export type ReportTemplate = { id: string; dependencies: string[]; styles: string };
export const reportRuntimeMessages = {
  en: {
    dependencyError:
      'Chart dependencies could not load. Check your connection and reopen the report.',
  },
  'zh-CN': { dependencyError: '图表依赖加载失败，请检查网络后重新打开报告。' },
};
export const reportTemplates: readonly ReportTemplate[] = [
  {
    id: 'general@1',
    dependencies: ['https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js'],
    styles:
      'body{margin:0 auto;padding:32px;max-width:1120px;font:16px/1.7 system-ui,sans-serif;color:#202124;background:#fff}img,svg,canvas{max-width:100%}table{border-collapse:collapse;width:100%}th,td{padding:12px;text-align:left;border-bottom:1px solid #ddd}h1,h2,h3{line-height:1.25}button,input,select{font:inherit} @media print{body{padding:0}}',
  },
];
export function reportPolicy(dependencies: readonly string[]) {
  // Exact URL sources; generated inline code is intentional, network/frames/forms are not.
  return `default-src 'none'; script-src 'unsafe-inline' ${dependencies.join(' ')}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
}
const attr = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
export function renderReport(
  source: string,
  template: ReportTemplate,
  bridge = '',
  messages = reportRuntimeMessages.en,
) {
  const dependencyError = JSON.stringify(messages.dependencyError).replaceAll('<', '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${attr(reportPolicy(template.dependencies))}"><style>${template.styles.replace(/<\/style/gi, '<\\/style')}</style>${bridge}${template.dependencies.map((url) => `<script src="${attr(url)}" crossorigin="anonymous" onerror="document.documentElement.dataset.dependencyError='true'"></script>`).join('')}<script>document.documentElement.dataset.reportDependencyErrorMessage=${dependencyError};addEventListener('load',()=>{if(document.documentElement.dataset.dependencyError){const p=document.createElement('p');p.textContent=document.documentElement.dataset.reportDependencyErrorMessage;p.dataset.reportDependencyError='';p.setAttribute('role','alert');document.body.prepend(p)}})</script></head><body>${source}</body></html>`;
}
