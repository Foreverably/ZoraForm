ALTER TABLE "files" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" DROP COLUMN "expires_at";--> statement-breakpoint
UPDATE "files" SET "expires_at" = NULL WHERE "session_id" IN (SELECT "session_id" FROM "submissions");
