CREATE TABLE "ad_ratings" (
	"user_id" uuid NOT NULL,
	"character_lower" text NOT NULL,
	"character" text NOT NULL,
	"score" integer NOT NULL,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_ratings_user_id_character_lower_pk" PRIMARY KEY("user_id","character_lower")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"identity_id" uuid NOT NULL,
	"tags" jsonb NOT NULL,
	"channels" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_identityId_unique" UNIQUE("identity_id")
);
--> statement-breakpoint
ALTER TABLE "ad_ratings" ADD CONSTRAINT "ad_ratings_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;