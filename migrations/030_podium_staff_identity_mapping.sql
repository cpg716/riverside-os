-- Stable Podium sender mapping for customer-message attribution.

ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS podium_user_uid text,
  ADD COLUMN IF NOT EXISTS podium_display_name text;

CREATE UNIQUE INDEX IF NOT EXISTS staff_podium_user_uid_uidx
  ON staff (podium_user_uid)
  WHERE podium_user_uid IS NOT NULL AND trim(podium_user_uid) <> '';

ALTER TABLE podium_message
  ADD COLUMN IF NOT EXISTS podium_sender_uid text;

UPDATE podium_message
SET podium_sender_uid = COALESCE(
  NULLIF(raw_payload->>'senderUid', ''),
  NULLIF(raw_payload#>>'{sender,uid}', ''),
  NULLIF(raw_payload#>>'{data,senderUid}', ''),
  NULLIF(raw_payload#>>'{data,sender,uid}', ''),
  NULLIF(raw_payload#>>'{data,message,senderUid}', ''),
  NULLIF(raw_payload#>>'{data,message,sender,uid}', '')
)
WHERE podium_sender_uid IS NULL
  AND raw_payload IS NOT NULL;

-- Older API-sync imports sometimes captured the contact name as the outbound sender.
-- Keep provider sender names only when they are not just the conversation contact.
UPDATE podium_message
SET podium_sender_name = NULL
WHERE podium_sender_name IS NOT NULL
  AND (
    podium_sender_name = NULLIF(raw_payload->>'contactName', '')
    OR podium_sender_name = NULLIF(raw_payload#>>'{contact,name}', '')
    OR podium_sender_name = NULLIF(raw_payload#>>'{data,contactName}', '')
    OR podium_sender_name = NULLIF(raw_payload#>>'{data,contact,name}', '')
  );

