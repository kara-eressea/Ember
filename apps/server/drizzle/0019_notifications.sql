CREATE TYPE "public"."notification_kind" AS ENUM('mention', 'friendrequest', 'note', 'comment');--> statement-breakpoint
CREATE TABLE "notification_seen" (
	"identity_id" uuid PRIMARY KEY NOT NULL,
	"last_seen_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"identity_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"conversation_id" uuid,
	"message_id" bigint,
	"character" text DEFAULT '' NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_seen" ADD CONSTRAINT "notification_seen_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_identity_id_idx" ON "notifications" USING btree ("identity_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_message_idx" ON "notifications" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "notifications_conversation_idx" ON "notifications" USING btree ("conversation_id");