CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"hostname" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"info" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_revisions" ADD COLUMN "event" jsonb;--> statement-breakpoint
UPDATE "booking_revisions" SET "event" = '{}'::jsonb WHERE "event" IS NULL;--> statement-breakpoint
ALTER TABLE "booking_revisions" ALTER COLUMN "event" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_revisions" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD COLUMN "state" jsonb DEFAULT '{}'::jsonb NOT NULL;