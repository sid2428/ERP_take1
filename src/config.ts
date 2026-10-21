import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_DATABASE_URL: z.string().min(1, 'APP_DATABASE_URL is required'),
  DATABASE_SSL: z.string().optional(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  PORT: z.coerce.number().int().positive().default(3000),
  VERCEL: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  throw new Error(`Invalid environment configuration — ${problems}`);
}

const databaseUrl = new URL(parsed.data.APP_DATABASE_URL);
if (databaseUrl.hostname === 'localhost') databaseUrl.hostname = '127.0.0.1';

export const config = {
  env: parsed.data.NODE_ENV,
  isProduction: parsed.data.NODE_ENV === 'production',
  isServerless: Boolean(parsed.data.VERCEL),
  databaseUrl: databaseUrl.toString(),
  databaseSsl: parsed.data.DATABASE_SSL !== 'false',
  sessionSecret: parsed.data.SESSION_SECRET,
  port: parsed.data.PORT,
} as const;
