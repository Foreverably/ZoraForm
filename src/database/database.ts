import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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

	async function applyMigrations() {
		const migrationsFolder = join(rootDir, 'drizzle');
		const journalPath = join(migrationsFolder, 'meta', '_journal.json');
		if (!existsSync(journalPath)) {
			throw new Error(`Migration journal not found: ${journalPath}`);
		}

		const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
			entries: Array<{ idx: number; when: number; tag: string }>;
		};

		const client = await connectionPool.connect();
		try {
			await client.query('BEGIN');
			try {
				await client.query(`
					CREATE TABLE IF NOT EXISTS public.__drizzle_migrations (
						id serial PRIMARY KEY,
						hash text NOT NULL,
						created_at bigint
					)
				`);
				await client.query('COMMIT');
			} catch (error) {
				await client.query('ROLLBACK');
				throw error;
			}

			for (const migration of journal.entries) {
				const migrationPath = join(migrationsFolder, `${migration.tag}.sql`);
				const sql = readFileSync(migrationPath, 'utf8');
				const hash = createHash('sha256').update(sql).digest('hex');
				const applied = await client.query(
					'SELECT 1 FROM public.__drizzle_migrations WHERE hash = $1 LIMIT 1',
					[hash]
				);
				if ((applied.rowCount ?? 0) > 0) {
					continue;
				}

				await client.query('BEGIN');
				try {
					for (const statement of sql.split('--> statement-breakpoint')) {
						if (statement.trim()) {
							await client.query(statement);
						}
					}
					await client.query(
						'INSERT INTO public.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
						[hash, migration.when]
					);
					await client.query('COMMIT');
				} catch (error) {
					await client.query('ROLLBACK');
					throw error;
				}
			}
		} finally {
			client.release();
		}
	}

	return {
		database,
		applyMigrations,
		close: () => connectionPool.end()
	};
}

export type Database = ReturnType<typeof createPostgresConnection>['database'];
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Queryable = Database | Transaction;
