-- Podium staff / agent display name when the message was not sent from ROS (e.g. Podium Web / app).

ALTER TABLE podium_message
    ADD COLUMN IF NOT EXISTS podium_sender_name TEXT;

COMMENT ON COLUMN podium_message.podium_sender_name IS 'Sender display name from Podium (webhook or future API sync). When set with direction outbound, use instead of ROS staff.';
