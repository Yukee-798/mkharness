import { reportsManifest } from './manifest';
import { BG } from '../../server/chat/context';
import { z } from 'zod';
import { validateReportSource } from './validate';
import { AppError } from '../../shared/contracts';
import type { WorkspaceServerPack } from '../../server/workspace/types';
import { WorkspaceDoc, ReportSources } from '../../server/workspace/documents';
import { reportTemplates } from './template';
const publication = z
  .object({
    id: z.string().min(1).max(160).optional(),
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().max(240).optional(),
    source: z.string().min(1).max(1000000),
    template: z.string().default('general@1'),
  })
  .strict();
export const reportsServer = {
  id: 'reports',
  version: reportsManifest.version,
  queries: {
    async report(input, { pi }) {
      const { id, revision } = z
        .object({ id: z.string(), revision: z.number().int().positive().optional() })
        .strict()
        .parse(input);
      const state = await pi.snapshot(WorkspaceDoc, BG),
        object = state?.objects[id];
      if (!object || object.type !== 'report') throw new AppError(404, 'report_not_found');
      const version = revision ?? Number(object.data.revision);
      if (version > Number(object.data.revision)) throw new AppError(404, 'revision_not_found');
      const source = await pi.snapshot(ReportSources, `${id}:${version}`, BG);
      if (!source) throw new AppError(404, 'revision_not_found');
      return { object, revision: version, ...source };
    },
  },
  commands: {
    'report.publish': {
      model: true,
      async invoke(raw, c) {
        const value = publication.parse(raw),
          reportId = value.id ?? crypto.randomUUID();
        const prior = c.state.objects[reportId];
        if (
          !prior &&
          Object.values(c.state.objects).filter((o) => o.type === 'report').length >= 20
        )
          throw new AppError(409, 'report_capacity');
        if (prior) {
          c.require(reportId, 'report');
          c.expect(reportId);
        }
        if (!prior && c.state.clocks[reportId]) throw new AppError(409, 'object_exists');
        const previous = prior
          ? await c.tx.doc(ReportSources, `${reportId}:${prior.data.revision}`, {
              source: '',
              template: '',
              dependencies: [],
              styles: '',
              createdAt: 0,
            })
          : undefined;
        const template = previous
          ? {
              id: previous.template,
              dependencies: [...previous.dependencies],
              styles: previous.styles,
            }
          : reportTemplates.find((t) => t.id === value.template);
        if (!template) throw new AppError(400, 'unknown_report_template');
        validateReportSource(
          value.source,
          template.dependencies,
          new Set(Object.keys(c.state.assets)),
        );
        const revision = Number(prior?.data.revision ?? 0) + 1;
        if (revision > 100) throw new AppError(409, 'report_revision_capacity');
        // Immutable source and current object reference are published atomically.
        await c.tx.doc(ReportSources, `${reportId}:${revision}`, {
          title: value.title,
          summary: value.summary ?? '',
          source: value.source,
          template: template.id,
          dependencies: [...template.dependencies],
          styles: template.styles,
          createdAt: Date.now(),
        });
        c.put({
          id: reportId,
          type: 'report',
          title: value.title,
          data: { revision, template: template.id, summary: value.summary ?? '' },
        });
        return { objectIds: [reportId] };
      },
    },
    'report.restore': {
      async invoke(raw, c) {
        const { id, revision } = z
          .object({ id: z.string().min(1).max(160), revision: z.number().int().positive() })
          .strict()
          .parse(raw);
        const report = c.require(id, 'report');
        c.expect(id);
        if (revision > Number(report.data.revision)) throw new AppError(404, 'revision_not_found');
        const old = await c.tx.doc(ReportSources, `${id}:${revision}`, {
          source: '',
          template: '',
          dependencies: [],
          styles: '',
          createdAt: 0,
        });
        if (!old.source) throw new AppError(404, 'revision_not_found');
        const next = Number(report.data.revision) + 1;
        if (next > 100) throw new AppError(409, 'report_revision_capacity');
        await c.tx.doc(ReportSources, `${id}:${next}`, {
          ...JSON.parse(JSON.stringify(old)),
          createdAt: Date.now(),
        });
        c.put({
          ...report,
          title: old.title ?? report.title,
          data: { revision: next, template: old.template, summary: old.summary ?? '' },
        });
        return { objectIds: [id] };
      },
    },
  },
} satisfies WorkspaceServerPack;
