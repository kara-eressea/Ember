CREATE TABLE "flist_credentials" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identities" ADD COLUMN "last_detached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "flist_credentials" ADD CONSTRAINT "flist_credentials_account_id_flist_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."flist_accounts"("id") ON DELETE cascade ON UPDATE no action;