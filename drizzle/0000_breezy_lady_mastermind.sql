CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"key" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"name" text NOT NULL,
	"size" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"published" jsonb,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_blacklist" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "guild_blacklist_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"error_code" text,
	CONSTRAINT "jobs_dedupe_unique" UNIQUE("dedupe")
);
--> statement-breakpoint
CREATE TABLE "processed_inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"form_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'prompt' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"prompt_id" text,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"form_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"answers" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"thread_id" text,
	"reviewer_id" text,
	"reason" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"delivery_state" text DEFAULT 'queued' NOT NULL,
	CONSTRAINT "submissions_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "submissions_thread_id_unique" UNIQUE("thread_id")
);
--> statement-breakpoint
CREATE TABLE "user_locks" (
	"user_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forms_guild" ON "forms" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_conversation" ON "sessions" USING btree ("user_id") WHERE "sessions"."status" in ('prompt','answer','confirm','paused');--> statement-breakpoint
CREATE INDEX "submissions_policy" ON "submissions" USING btree ("form_id","user_id","created_at");