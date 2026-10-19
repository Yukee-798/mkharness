import { validateReportSource } from '../../src/scenarios/reports/validate';
import { it, expect } from 'vitest';
import config from '../../scenarios.config';
import { validateScenarios } from '../../src/scenarios/registry';
import { renderReport, reportTemplates } from '../../src/scenarios/reports/template';
import { reportBridge } from '../../src/scenarios/reports/sandbox';
it('validates package dependencies and both runtime entries before activation', () => {
  expect(validateScenarios(config, ['canvas', 'reports'], ['canvas', 'reports'])).toBe(config);
  expect(() => validateScenarios(config, ['canvas'], ['canvas', 'reports'])).toThrow(
    'Missing server',
  );
  expect(() => validateScenarios(config, ['canvas', 'reports'], ['canvas'])).toThrow(
    'Missing browser',
  );
  expect(() =>
    validateScenarios(
      { ...config, packs: [{ ...config.packs[0], dependencies: ['reports'] }, config.packs[1]] },
      ['canvas', 'reports'],
      ['canvas', 'reports'],
    ),
  ).toThrow('Cyclic');
});
it('pins chart dependency and isolates scripts while exporting no host bridge', () => {
  const source =
    '<h1 id="summary">报告</h1><div id="chart"></div><script>echarts.init(document.getElementById("chart"));</script>';
  const html = renderReport(source, reportTemplates[0]);
  expect(html).toContain('echarts@5.6.0/dist/echarts.min.js');
  expect(html).toContain("connect-src 'none'");
  expect(html).toContain("base-uri 'none'");
  expect(html).not.toContain('report:connect');
  const preview = renderReport(source, reportTemplates[0], reportBridge('current-version'));
  expect(preview).toContain('current-version');
  expect(preview).toContain('event.source !== parent');
  expect(preview).not.toContain('workspace/execute');
});

it('rejects malformed JS, undeclared dependencies and foreign assets before replacing a report', () => {
  expect(() => validateReportSource('<script>const = ;</script>', [], new Set())).toThrow(
    '语法有误',
  );
  expect(() =>
    validateReportSource('<script src="https://evil.test/a.js"></script>', [], new Set()),
  ).toThrow('模板');
  expect(() => validateReportSource('<img src="workspace-asset:other">', [], new Set())).toThrow(
    'report_asset_unavailable',
  );
  expect(() =>
    validateReportSource(
      '<script>window.answer=42</script><img src="workspace-asset:owned">',
      [],
      new Set(['owned']),
    ),
  ).not.toThrow();
});
