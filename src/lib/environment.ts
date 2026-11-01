import { setup } from '@skyra/env-utilities';
import { join } from 'node:path';

export const rootDir = join(__dirname, '..', '..');

export function initializeEnvironment() {
	process.env.NODE_ENV ??= 'development';

	setup({ path: join(rootDir, '.env') });
}
