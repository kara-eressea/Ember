ALTER TABLE "character_notes" ADD COLUMN "timezone" text;--> statement-breakpoint
CREATE INDEX "messages_sender_lower_idx" ON "messages" USING btree (lower("sender_character"),"created_at");