import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { parse } from 'acorn';
import { AppError } from '../../shared/contracts';
/** Validate stored source before publication; CSP/sandbox enforce runtime policy. */
export function validateReportSource(
  source: string,
  dependencies: readonly string[],
  assetIds: ReadonlySet<string>,
) {
  const walk = (node: DefaultTreeAdapterMap['node']) => {
    if ('tagName' in node) {
      const attrs = Object.fromEntries(node.attrs.map((a) => [a.name, a.value]));
      if (
        ['base', 'iframe', 'frame', 'object', 'embed'].includes(node.tagName) ||
        (node.tagName === 'meta' && attrs['http-equiv'])
      )
        throw new AppError(
          400,
          'report_unsupported_resource',
          '报告包含不支持的嵌套页面或导航设置',
        );
      if (node.tagName === 'script') {
        if (attrs.src && !dependencies.includes(attrs.src))
          throw new AppError(400, 'report_dependency_not_declared', '报告只能引用模板声明的依赖');
        if (
          !attrs.src &&
          (!attrs.type ||
            ['text/javascript', 'application/javascript', 'module'].includes(attrs.type))
        ) {
          const code = node.childNodes
            .filter((n): n is DefaultTreeAdapterMap['textNode'] => n.nodeName === '#text')
            .map((n) => n.value)
            .join('');
          try {
            parse(code, {
              ecmaVersion: 'latest',
              sourceType: attrs.type === 'module' ? 'module' : 'script',
            });
          } catch {
            throw new AppError(
              400,
              'report_script_invalid',
              '报告 JavaScript 语法有误，旧版本已保留',
            );
          }
        }
      }
      if (node.tagName === 'link' && attrs.href)
        throw new AppError(400, 'report_dependency_not_declared', '请将样式放入报告或模板样式定义');
      for (const [name, value] of Object.entries(attrs)) {
        if (name.startsWith('on')) {
          try {
            parse(`function handler(event){${value}\n}`, { ecmaVersion: 'latest' });
          } catch {
            throw new AppError(400, 'report_script_invalid');
          }
        }
        if (
          ['src', 'poster', 'srcset'].includes(name) &&
          node.tagName !== 'script' &&
          !value.startsWith('data:') &&
          !value.startsWith('workspace-asset:')
        )
          throw new AppError(
            400,
            'report_image_not_managed',
            '图片请使用工作区素材引用或 data URL',
          );
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) walk(child);
    if ('content' in node && node.content) walk(node.content);
  };
  walk(parseFragment(source));
  for (const match of source.matchAll(/workspace-asset:([a-zA-Z0-9:_-]+)/g))
    if (!assetIds.has(match[1])) throw new AppError(404, 'report_asset_unavailable');
}
