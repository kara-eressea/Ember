CREATE TABLE "character_cache" (
	"character_lower" text PRIMARY KEY NOT NULL,
	"character_name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_notes" (
	"identity_id" uuid NOT NULL,
	"character_lower" text NOT NULL,
	"note" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_notes_identity_id_character_lower_pk" PRIMARY KEY("identity_id","character_lower")
);
--> statement-breakpoint
CREATE TABLE "flist_mappings" (
	"source" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_views" (
	"identity_id" uuid NOT NULL,
	"character_lower" text NOT NULL,
	"character_name" text NOT NULL,
	"first_viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"view_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "profile_views_identity_id_character_lower_pk" PRIMARY KEY("identity_id","character_lower")
);
--> statement-breakpoint
ALTER TABLE "character_notes" ADD CONSTRAINT "character_notes_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_views" ADD CONSTRAINT "profile_views_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_views_identity_recency_idx" ON "profile_views" USING btree ("identity_id","last_viewed_at" DESC NULLS LAST);