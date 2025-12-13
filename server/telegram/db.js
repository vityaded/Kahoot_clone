import fs from 'fs/promises';
import path from 'path';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function withClient(handler) {
  const client = await pool.connect();
  try {
    return await handler(client);
  } finally {
    client.release();
  }
}

export async function runMigrations() {
  const schemaPath = path.join(process.cwd(), 'server', 'telegram', 'schema.sql');
  const sql = await fs.readFile(schemaPath, 'utf8');
  await withClient(async (client) => client.query(sql));
}

export async function endPool() {
  await pool.end();
}
