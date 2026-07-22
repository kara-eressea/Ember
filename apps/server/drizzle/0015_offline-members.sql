CREATE TABLE "seen_members" (
	"identity_id" uuid NOT NULL,
	"channel_key" text NOT NULL,
	"character_lower" text NOT NULL,
	"character" text NOT NULL,
	"gender" text DEFAULT '' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seen_members_identity_id_channel_key_character_lower_pk" PRIMARY KEY("identity_id","channel_key","character_lower")
);
--> statement-breakpoint
ALTER TABLE "seen_members" ADD CONSTRAINT "seen_members_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seen_members_recency_idx" ON "seen_members" USING btree ("identity_id","channel_key","last_seen_at" DESC NULLS LAST);