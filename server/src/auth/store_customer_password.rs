//! Argon2 passwords for public `/shop` customer sign-in (not staff PIN rules).

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand_core::OsRng;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreCustomerPasswordError {
    #[error("password must be at least 8 characters")]
    TooShort,
    #[error("password is too long")]
    TooLong,
    #[error("hashing failed")]
    Hash,
}

const MIN_LEN: usize = 8;
const MAX_LEN: usize = 256;

pub fn hash_customer_password(password: &str) -> Result<String, StoreCustomerPasswordError> {
    let p = password.trim();
    if p.len() < MIN_LEN {
        return Err(StoreCustomerPasswordError::TooShort);
    }
    if p.len() > MAX_LEN {
        return Err(StoreCustomerPasswordError::TooLong);
    }
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(p.as_bytes(), &salt)
        .map_err(|_| StoreCustomerPasswordError::Hash)?;
    Ok(hash.to_string())
}

pub fn verify_customer_password(password: &str, stored: &str) -> bool {
    let p = password.trim();
    if p.is_empty() || stored.is_empty() {
        return false;
    }
    let Ok(parsed) = PasswordHash::new(stored) else {
        return false;
    };
    Argon2::default()
        .verify_password(p.as_bytes(), &parsed)
        .is_ok()
}
