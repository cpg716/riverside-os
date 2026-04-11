-- Adding personalized loyalty letter template to store settings
ALTER TABLE store_settings
    ADD COLUMN IF NOT EXISTS loyalty_letter_template TEXT NOT NULL DEFAULT 'Dear {{first_name}}, 

Congratulations! Your loyalty to Riverside has earned you a ${{reward_amount}} reward. 

We have loaded this reward onto a personalized gift card for you:
CODE: {{card_code}}

Thank you for being part of our community. We look ahead to seeing you again soon!

Best regards,
The Riverside Team';
