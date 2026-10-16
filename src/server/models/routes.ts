import { Hono } from 'hono';
import { z } from 'zod';
import { boundedText } from '../http/body';
import { AppError } from '../../shared/contracts';
import { ModelCredentials } from './credentials';
import {
  applicationModels,
  configuredModelCatalog,
  validateModelSelection,
  modelProviders,
  registeredProvider,
} from './catalog';

export const modelRoutes = new Hono<{ Bindings: Env; Variables: { userId: string } }>();
modelRoutes.get('/models', async (c) => {
  const credentials = new ModelCredentials(c.env, c.get('userId'));
  return c.json({
    providers: modelProviders.map(({ id, name, factory, defaultModel }) => ({
      id,
      name,
      baseUrl: factory().baseUrl!,
      defaultModelId: defaultModel,
    })),
    modelCatalog: configuredModelCatalog(
      c.env,
      applicationModels(c.env),
      await credentials.configuredModels(),
    ),
    credentials: await Promise.all(modelProviders.map((p) => credentials.metadata(p.id))),
    credentialStorageReady: credentials.storageReady,
  });
});
modelRoutes.on(['PUT', 'DELETE'], '/model-credentials/:provider', async (c) => {
  const provider = registeredProvider(c.req.param('provider')).id;
  let body: unknown;
  try {
    body = JSON.parse(
      await boundedText(new Response(c.req.raw.body, { headers: c.req.raw.headers }), 16 * 1024),
    );
  } catch {
    throw new AppError(400, 'invalid_credential_request');
  }
  const expected = z.uuid().nullable();
  const schema =
    c.req.method === 'PUT'
      ? z
          .object({
            apiKey: z.string(),
            baseUrl: z.string().max(2048).optional(),
            modelId: z.string().trim().min(1).max(200).optional(),
            expectedCurrentId: expected,
          })
          .strict()
      : z.object({ expectedCurrentId: expected }).strict();
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AppError(400, 'invalid_credential_request');
  if (
    'apiKey' in parsed.data &&
    'modelId' in parsed.data &&
    typeof parsed.data.modelId === 'string'
  ) {
    const models = applicationModels(c.env);
    const model = models.getModel(provider, parsed.data.modelId);
    if (!model)
      throw new AppError(
        400,
        'unknown_model',
        '模型名未在当前 Pi 目录注册，请填写受支持的 API 模型名',
      );
    validateModelSelection(c.env, models, { provider, modelId: model.id, thinkingLevel: 'off' });
  }
  const credentials = new ModelCredentials(c.env, c.get('userId'));
  return c.json(
    'apiKey' in parsed.data
      ? await credentials.save(
          provider,
          parsed.data as {
            apiKey: string;
            baseUrl?: string;
            modelId?: string;
            expectedCurrentId: string | null;
          },
        )
      : await credentials.remove(provider, parsed.data.expectedCurrentId),
  );
});
