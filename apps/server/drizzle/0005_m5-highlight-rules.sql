CREATE TYPE "public"."highlight_rule_kind" AS ENUM('word', 'nick', 'regex');--> statement-breakpoint
CREATE TABLE "highlight_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "highlight_rule_kind" NOT NULL,
	"pattern" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "mention" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "highlight_rules" ADD CONSTRAINT "highlight_rules_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "highlight_rules_user_kind_pattern_uniq" ON "highlight_rules" USING btree ("user_id","kind","pattern");--> statement-breakpoint
-- Backfill the stored flag with the pre-M5 semantic (receiving identity's
-- character name, ASCII word boundaries, case-insensitive) so unread mention
-- badges survive the switch from snapshot-time rescan to the persisted flag.
-- Names use the F-List charset (alnum, _, -, space); every one of those
-- characters is regex-literal in the wrapped pattern, so no escaping needed.
UPDATE "messages" m
SET "mention" = true
FROM "conversations" c
JOIN "identities" i ON i."id" = c."identity_id"
WHERE m."conversation_id" = c."id"
  AND m."kind" = 'msg'
  AND NOT m."sent_by_us"
  AND m."bbcode" ~* ('(^|[^a-zA-Z0-9_])' || i."character_name" || '([^a-zA-Z0-9_]|$)');
