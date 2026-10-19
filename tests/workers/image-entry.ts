import { ChatSession } from './entry';
import { imagesContribution } from '../../src/extensions/images/server';
import { imageFiles } from '../../src/extensions/images/store';

export const fixturePNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
);
export class ImageProbe extends ChatSession {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS test_image_probe(name TEXT PRIMARY KEY, value TEXT)',
    );
  }
  private count(name: string) {
    this.ctx.storage.sql.exec(
      "INSERT INTO test_image_probe(name,value)VALUES(?,'1') ON CONFLICT(name)DO UPDATE SET value=CAST(value AS INTEGER)+1",
      name,
    );
  }
  imageProbe(mode?: string): Record<string, string> {
    if (mode)
      this.ctx.storage.sql.exec(
        "INSERT INTO test_image_probe(name,value)VALUES('mode',?) ON CONFLICT(name)DO UPDATE SET value=excluded.value",
        mode,
      );
    return Object.fromEntries(
      this.ctx.storage.sql
        .exec('SELECT name,value FROM test_image_probe')
        .toArray()
        .map((row) => [String(row.name), String(row.value)]),
    );
  }
  protected override async contributions() {
    return [
      ...(await super.contributions()).filter((item) => item.id !== 'images'),
      imagesContribution(
        {
          provider: {
            identity: 'image-fixture',
            submit: async () => {
              this.count('submit');
              if (this.imageProbe().mode === 'unknown') throw new Error('Lost receipt');
              return 'job-1';
            },
            inspect: async () => {
              this.count('poll');
              return this.imageProbe().mode === 'ready'
                ? { status: 'succeeded', urls: ['https://images.example.test/result.png'] }
                : { status: 'pending' };
            },
          },
          files: imageFiles(this.env.ARTIFACT_FILES, {
            fetcher: async () => {
              this.count('download');
              return new Response(fixturePNG, { headers: { 'Content-Type': 'image/png' } });
            },
            resolve: async () => ['93.184.216.34'],
          }),
          pollMs: 25,
          waitMs: 15000,
        },
        this.contributionHost(),
      ),
    ];
  }
}
