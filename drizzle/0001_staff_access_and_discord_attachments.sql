CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"notified" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_blacklist" (
	"guild_id" text NOT NULL,
	"role_id" text NOT NULL,
	CONSTRAINT "role_blacklist_guild_id_role_id_pk" PRIMARY KEY("guild_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "staff_grants" (
	"guild_id" text NOT NULL,
	"capability" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	CONSTRAINT "staff_grants_guild_id_capability_subject_type_subject_id_pk" PRIMARY KEY("guild_id","capability","subject_type","subject_id")
);
--> statement-breakpoint
CREATE TABLE "submission_replies" (
	"source_interaction_id" text,
	"id" uuid PRIMARY KEY NOT NULL,
	"submission_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "submission_replies_source_interaction_id_unique" UNIQUE("source_interaction_id")
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "source_channel_id" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "source_message_id" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "source_attachment_id" text;--> statement-breakpoint
ALTER TABLE "submission_replies" ADD CONSTRAINT "submission_replies_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;