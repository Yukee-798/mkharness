import { betterAuth } from 'better-auth';
import { anonymous } from 'better-auth/plugins';
import { AppError } from '../shared/contracts';
export type AuthMode = 'guest' | 'account';
export function authMode(env: { AUTH_MODE?: string }): AuthMode {
  const mode = env.AUTH_MODE ?? 'guest';
  if (mode !== 'guest' && mode !== 'account') throw new AppError(503, 'invalid_auth_mode');
  return mode;
}
export function auth(env: Env) {
  const mode = authMode(env);
  if (
    !env.BETTER_AUTH_SECRET ||
    (mode === 'account' && (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET))
  )
    throw new AppError(
      503,
      'auth_not_configured',
      mode === 'account'
        ? 'Configure Better Auth secret and Google OAuth credentials'
        : 'Configure BETTER_AUTH_SECRET',
    );
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    basePath: '/api/auth',
    database: env.DB,
    socialProviders:
      mode === 'account'
        ? {
            google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
          }
        : {},
    plugins:
      mode === 'guest'
        ? [anonymous({ disableDeleteAnonymousUser: true, generateName: () => '访客' })]
        : [],
    user: {
      additionalFields: {
        isAnonymous: { type: 'boolean', required: false, defaultValue: false, input: false },
      },
    },
    trustedOrigins: [env.APP_URL],
    session: { cookieCache: { enabled: false } },
  });
}
