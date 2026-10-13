import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unstable_getVarsForDev, unstable_readConfig } from 'wrangler';
import { expect, it } from 'vitest';

it.each([undefined, 'test'])('loads optional local capabilities and credentials (%s)', (env) => {
  const config = unstable_readConfig({ config: 'wrangler.jsonc', env });
  const directory = mkdtempSync(join(tmpdir(), 'agent-dev-vars-'));
  try {
    writeFileSync(
      join(directory, '.dev.vars'),
      'TOOL_CALL_LIMIT=50\nMODEL_THINKING_LEVEL=medium\nTAVILY_API_KEY=fixture\nREFERENCE_MCP_TOKEN=fixture\n',
    );
    const bindings = unstable_getVarsForDev(
      join(directory, 'wrangler.jsonc'),
      undefined,
      config.vars,
      undefined,
      true,
      config.secrets,
    );
    expect(bindings.TOOL_CALL_LIMIT?.value).toBe('50');
    expect(bindings.MODEL_THINKING_LEVEL?.value).toBe('medium');
    expect(bindings.TAVILY_API_KEY?.value).toBe('fixture');
    expect(bindings.REFERENCE_MCP_TOKEN?.value).toBe('fixture');
  } finally {
    rmSync(directory, { recursive: true });
  }
});
