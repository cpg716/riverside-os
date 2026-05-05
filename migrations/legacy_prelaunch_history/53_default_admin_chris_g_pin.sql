-- Default POS / Back Office bootstrap: Chris G, admin, 4-digit code 1234 with Argon2 hash of same code.

INSERT INTO staff (
    full_name,
    cashier_code,
    pin_hash,
    role,
    is_active
)
VALUES (
    'Chris G',
    '1234',
    '$argon2id$v=19$m=19456,t=2,p=1$KWJoKjtQYNuPjRIyKL2M9g$FBpoET53ejevTU5LrsLTzQMrgXpV5NavqruJmerdPsc',
    'admin'::staff_role,
    TRUE
)
ON CONFLICT (cashier_code) DO UPDATE
SET
    full_name = EXCLUDED.full_name,
    role = EXCLUDED.role,
    pin_hash = EXCLUDED.pin_hash,
    is_active = TRUE;
