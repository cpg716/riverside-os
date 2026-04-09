-- Default POS / Back Office bootstrap: Chris G, admin, 4-digit code 1234 with Argon2 hash of same code.

UPDATE staff
SET
    full_name = 'Chris G',
    role = 'admin'::staff_role,
    pin_hash = '$argon2id$v=19$m=19456,t=2,p=1$KWJoKjtQYNuPjRIyKL2M9g$FBpoET53ejevTU5LrsLTzQMrgXpV5NavqruJmerdPsc'
WHERE cashier_code = '1234';
