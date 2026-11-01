import { defineConfig } from 'drizzle-kit';
import { loadEnvFile } from 'node:process';
try {
	loadEnvFile();
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
export default defineConfig({
	schema: './src/database/schema.ts',
	out: './drizzle',
	dialect: 'postgresql',
	dbCredentials: { url: process.env.DATABASE_URL ?? '' }
});
