import 'dotenv/config';
import pg from 'pg';

/** Single connection for maintenance scripts (migrate / load / verify). */
export async function connect(): Promise<pg.Client> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set (copy .env.example to .env and fill it in)');
  }
  const client = new pg.Client({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

export async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
