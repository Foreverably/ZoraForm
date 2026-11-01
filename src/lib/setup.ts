process.env.NODE_ENV ??= 'development';
import '@sapphire/plugin-logger/register';
import { setup } from '@skyra/env-utilities';
import { join } from 'node:path';
import { rootDir } from './constants';
setup({ path: join(rootDir, '.env') });
