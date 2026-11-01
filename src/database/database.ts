import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'node:path';
import * as schema from './schema';
import { rootDir } from '../lib/constants';

export function postgres(connectionString: string) {
	const pool = new Pool({
		connectionString,
		max: 5,
		connectionTimeoutMillis: 10000
	});
	pool.on('error', () => console.error('PostgreSQL pool connection failed.'));
	const db = drizzle(pool, { schema });
	return {
		db,
		migrate: () => migrate(db, { migrationsFolder: join(rootDir, 'drizzle') }),
		close: () => pool.end()
	};
}

export type Database = ReturnType<typeof postgres>['db'];

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type Queryable = Database | Transaction;
