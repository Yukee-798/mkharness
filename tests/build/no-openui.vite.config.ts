import { defineConfig, type Plugin } from 'vite';
import base from '../../vite.config';
const removeOpenUI: Plugin = {
  name: 'test-only-remove-openui-assembly',
  enforce: 'pre',
  transform(code, id) {
    if (id.endsWith('/src/extensions/server.ts')) {
      const marker = code.indexOf("    id: 'openui'");
      const start = code.lastIndexOf('  {', marker);
      const next = code.indexOf('\n  {', marker);
      if (marker < 0 || start < 0 || next < 0)
        throw new Error('OpenUI server assembly fixture needs updating');
      return code.slice(0, start) + code.slice(next + 1);
    }
    if (id.endsWith('/src/extensions/browser.ts')) return code.replace(/^\s*openui:.*\n/m, '');
  },
  generateBundle(_options, bundle) {
    const modules = Object.values(bundle).flatMap((item) =>
      item.type === 'chunk' ? Object.keys(item.modules) : [],
    );
    const forbidden = modules.filter(
      (id) => id.includes('@openuidev') || id.includes('/extensions/openui/'),
    );
    if (forbidden.length)
      throw new Error('Removed OpenUI remains in module graph: ' + forbidden.join(', '));
    this.emitFile({
      type: 'asset',
      fileName: 'module-evidence.json',
      source: JSON.stringify({ openuiModules: forbidden, modules: modules.length }),
    });
  },
};
export default defineConfig({
  ...base,
  plugins: [...(base.plugins ?? []), removeOpenUI],
  build: {
    outDir: 'test-results/no-openui',
  },
});
