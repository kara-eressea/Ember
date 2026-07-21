-- For PM conversations the joined column now doubles as the "window open"
-- flag (gateway pm.close clears it; pm.open and inbound messages set it).
-- Existing PM rows predate the flag and were all visible — keep them so.
UPDATE "conversations" SET "joined" = true WHERE "kind" = 'pm';
