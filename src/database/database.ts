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
				await client.query(`
					DELETE FROM public.__drizzle_migrations
					WHERE id IN (
						SELECT id
						FROM (
							SELECT id, row_number() OVER (PARTITION BY hash ORDER BY id) AS duplicate_number
							FROM public.__drizzle_migrations
						) duplicates
						WHERE duplicate_number > 1
					)
				`);
				await client.query('COMMIT');
			} catch (error) {
				await client.query('ROLLBACK');
				throw error;
			}

			const migrationSignatures: Record<string, () => Promise<boolean>> = {
				'0000_breezy_lady_mastermind': async () =>
					(
						await client.query(`
							SELECT EXISTS (
								SELECT 1
							FROM information_schema.tables
							WHERE table_schema = 'public'
								AND table_name = 'audit_events'
							) AS exists
						`)
					).rows[0].exists,
				'0001_staff_access_and_discord_attachments': async () =>
					(
						await client.query(`
							SELECT
								(
									SELECT COUNT(*)::int
									FROM information_schema.tables
									WHERE table_schema = 'public'
										AND table_name IN (
											'rate_limit_buckets', 'role_blacklist',
											'staff_grants', 'submission_replies'
										)
								) = 4
								AND (
									SELECT COUNT(*)::int
									FROM information_schema.columns
									WHERE table_schema = 'public'
										AND table_name = 'files'
										AND column_name IN (
											'source_channel_id',
											'source_message_id',
											'source_attachment_id'
										)
								) = 3 AS complete
						`)
					).rows[0].complete,
				'0002_retired_question_files': async () =>
					(
						await client.query(`
							SELECT EXISTS (
								SELECT 1 FROM information_schema.tables
								WHERE table_schema = 'public' AND table_name = 'retired_question_files'
							)
						`)
					).rows[0].exists,
				'0003_applicant_review_message': async () =>
					(
						await client.query(`
							SELECT EXISTS (
								SELECT 1 FROM information_schema.columns
								WHERE table_schema = 'public'
									AND table_name = 'submissions'
									AND column_name = 'review_message_id'
							)
						`)
					).rows[0].exists,
				'0004_remove_server_blacklists': async () =>
					!(
						await client.query(`
							SELECT EXISTS (
								SELECT 1 FROM information_schema.tables
								WHERE table_schema = 'public'
									AND table_name IN ('guild_blacklist', 'role_blacklist')
							)
						`)
					).rows[0].exists,
				'0005_keep_submissions_permanently': async () =>
					!(
						await client.query(`
							SELECT EXISTS (
								SELECT 1 FROM information_schema.columns
								WHERE table_schema = 'public'
									AND table_name = 'submissions'
									AND column_name = 'expires_at'
							)
						`)
					).rows[0].exists,
				'0006_session_review_page': async () =>
					(
						await client.query(`
							SELECT EXISTS (
								SELECT 1 FROM information_schema.columns
								WHERE table_schema = 'public'
									AND table_name = 'sessions'
									AND column_name = 'review_page'
							)
						`)
					).rows[0].exists
			};

			for (const migration of journal.entries) {
				const migrationPath = join(migrationsFolder, `${migration.tag}.sql`);
				const sql = readFileSync(migrationPath, 'utf8');
				const hash = createHash('sha256').update(sql).digest('hex');
				const applied = await client.query(
					'SELECT 1 FROM public.__drizzle_migrations WHERE hash = $1 LIMIT 1',
					[hash]
				);
				if (
					(applied.rowCount ?? 0) === 0 &&
					(await migrationSignatures[migration.tag]?.())
				) {
					await client.query(
						`INSERT INTO public.__drizzle_migrations (hash, created_at)
						 SELECT $1, $2
						 WHERE NOT EXISTS (
							SELECT 1 FROM public.__drizzle_migrations WHERE hash = $1
						 )`,
						[hash, migration.when]
					);
				}
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
