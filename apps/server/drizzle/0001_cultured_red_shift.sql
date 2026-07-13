DROP INDEX "conversations_identity_target_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_identity_channel_uniq" ON "conversations" USING btree ("identity_id","channel_key") WHERE kind = 'channel';--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_identity_partner_uniq" ON "conversations" USING btree ("identity_id",lower("partner_character")) WHERE kind = 'pm';