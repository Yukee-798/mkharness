import { betterAuth } from 'better-auth';
import { AppError } from '../shared/contracts';
export function auth(env: Env) {
  if (!env.BETTER_AUTH_SECRET || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
    throw new AppError(
      503,
      'auth_not_configured',
      'Configure Better Auth secret and Google OAuth credentials',
    );
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    basePath: '/api/auth',
    database: env.DB,
    socialProviders: {
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    },
    trustedOrigins: [env.APP_URL],
    session: { cookieCache: { enabled: false } },
  });
}
