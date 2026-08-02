ALTER TABLE "auth_sessions" ADD COLUMN "prev_refresh_token_hash" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "rotated_at" timestamp with time zone;