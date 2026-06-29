import type { Config } from 'drizzle-kit';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

export default {
  schema: ['./src/common/database/schema.ts', './src/common/database/schema-relations.ts'],
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
} satisfies Config;
