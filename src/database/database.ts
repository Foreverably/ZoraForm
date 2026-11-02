import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'node:path';
import * as schema from './schema';
import { rootDir } from '../lib/environment';

export function createPostgresConnection(connectionString: string) {
	const connectionPool = new Pool({
		connectionString,
		max: 5,
		connectionTimeoutMillis: 10000
	});

	connectionPool.on('error', () => console.error('PostgreSQL pool connection failed.'));

	const database = drizzle(connectionPool, { schema });

	return {
		database,
		applyMigrations: () =>
			migrate(database, {
				migrationsFolder: join(rootDir, 'drizzle'),
				migrationsSchema: 'public'
			}),
		close: () => connectionPool.end()
	};
}

export type Database = ReturnType<typeof createPostgresConnection>['database'];
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Queryable = Database | Transaction;
