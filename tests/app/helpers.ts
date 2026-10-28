import 'dotenv/config';
import request from 'supertest';
import type { Express } from 'express';

export const hasAppEnv = Boolean(process.env.APP_DATABASE_URL && process.env.SESSION_SECRET && process.env.DEMO_PASSWORD);
export const hasAdminEnv = Boolean(hasAppEnv && process.env.ADMIN_PASSWORD);

export function csrfFrom(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match?.[1]) throw new Error('no CSRF token on page');
  return match[1];
}

/** A cookie-keeping client that has signed in (or tried to) with the given credentials. */
export async function signIn(app: Express, loginId: string, password: string, next = '') {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form')
    .send({ _csrf: csrfFrom(page.text), login_id: loginId, password, next });
  return { agent, res };
}

/** POST a form on behalf of a signed-in agent, taking the CSRF token from `formPage`. */
export async function postForm(agent: ReturnType<typeof request.agent>, formPage: string, action: string, fields: Record<string, string>) {
  const page = await agent.get(formPage);
  return agent.post(action).type('form').send({ _csrf: csrfFrom(page.text), ...fields });
}
