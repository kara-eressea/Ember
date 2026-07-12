CREATE TYPE "public"."conversation_kind" AS ENUM('channel', 'pm');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('msg', 'lrp', 'rll', 'sys', 'pm');--> statement-breakpoint
CREATE TABLE "app_users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_users_email_unique" UNIQUE("email"),
	CONSTRAINT "app_users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"device_label" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_refreshTokenHash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"identity_id" uuid NOT NULL,
	"kind" "conversation_kind" NOT NULL,
	"channel_key" text,
	"partner_character" text,
	"title" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"joined" boolean DEFAULT false NOT NULL,
	"last_read_message_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flist_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"flist_account_id" uuid NOT NULL,
	"character_name" text NOT NULL,
	"auto_connect" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ignores" (
	"identity_id" uuid NOT NULL,
	"character" text NOT NULL,
	CONSTRAINT "ignores_identity_id_character_pk" PRIMARY KEY("identity_id","character")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_character" text NOT NULL,
	"kind" "message_kind" NOT NULL,
	"bbcode" text NOT NULL,
	"source_markdown" text,
	"sent_by_us" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"identity_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"markdown" text NOT NULL,
	"bbcode" text NOT NULL,
	"release_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flist_accounts" ADD CONSTRAINT "flist_accounts_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_flist_account_id_flist_accounts_id_fk" FOREIGN KEY ("flist_account_id") REFERENCES "public"."flist_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ignores" ADD CONSTRAINT "ignores_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_identity_target_uniq" ON "conversations" USING btree ("identity_id","kind",coalesce("channel_key", "partner_character"));--> statement-breakpoint
CREATE UNIQUE INDEX "flist_accounts_user_account_uniq" ON "flist_accounts" USING btree ("user_id","account_name");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_account_character_uniq" ON "identities" USING btree ("flist_account_id","character_name");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_idx" ON "messages" USING btree ("conversation_id","id" DESC NULLS LAST);