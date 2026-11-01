import { eq } from 'drizzle-orm';
import type { Database, Queryable } from '../../../database/database';
import { rateLimitBuckets } from '../../../database/schema';
import { FormError } from '../domain/rules';

export type RateLimitCategory = 'message' | 'interaction' | 'command';
const windowMilliseconds = 10000;
const categoryLimits: Record<RateLimitCategory, number> = {
	message: 8,
	interaction: 15,
	command: 6
};

export class RateLimitError extends FormError {
	public constructor(
		public readonly shouldNotify: boolean,
		public readonly retryAfter: number
	) {
		super(
			`Please slow down and try again in ${Math.max(1, Math.ceil(retryAfter / 1000))} seconds.`
		);
	}
}

export class RateLimits {
	public constructor(
		private readonly database: Database,
		private readonly now: () => number = Date.now
	) {}

	private async consumeBucket(database: Queryable, key: string, limit: number) {
		const timestamp = this.now();
		await database
			.insert(rateLimitBuckets)
			.values({ key, windowStartedAt: new Date(timestamp) })
			.onConflictDoNothing();
		const [bucket] = await database
			.select()
			.from(rateLimitBuckets)
			.where(eq(rateLimitBuckets.key, key))
			.for('update');

		if (!bucket) {
			throw new FormError('The rate limit could not be checked. Please retry.');
		}

		const expired = timestamp - bucket.windowStartedAt.getTime() >= windowMilliseconds;
		const hits = expired ? 0 : bucket.hits;
		const notified = expired ? false : bucket.notified;
		const startedAt = expired ? timestamp : bucket.windowStartedAt.getTime();
		const allowed = hits < limit;

		await database
			.update(rateLimitBuckets)
			.set({
				windowStartedAt: new Date(startedAt),
				hits: Math.min(limit, hits + 1),
				notified: !allowed || notified
			})
			.where(eq(rateLimitBuckets.key, key));

		return {
			allowed,
			shouldNotify: !notified,
			retryAfter: windowMilliseconds - (timestamp - startedAt)
		};
	}

	public async enforce(userId: string, category: RateLimitCategory) {
		const result = await this.database.transaction(async (database) => {
			const globalLimit = await this.consumeBucket(database, `all:${userId}`, 20);

			if (!globalLimit.allowed) {
				return globalLimit;
			}

			return this.consumeBucket(database, `${category}:${userId}`, categoryLimits[category]);
		});

		if (!result.allowed) {
			throw new RateLimitError(result.shouldNotify, result.retryAfter);
		}
	}
}
