CREATE TYPE "public"."channel_directory_kind" AS ENUM('official', 'open');--> statement-breakpoint
CREATE TABLE "channel_directory" (
	"channel_key" text PRIMARY KEY NOT NULL,
	"kind" "channel_directory_kind" NOT NULL,
	"title" text NOT NULL,
	"last_seen_count" integer DEFAULT 0 NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
