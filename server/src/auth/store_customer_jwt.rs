//! HS256 JWT for authenticated `/api/store/account/*` requests.

use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

const TOKEN_TYP: &str = "ros_store_customer";

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    exp: i64,
    iat: i64,
    typ: String,
}

#[derive(Debug, Error)]
pub enum StoreCustomerJwtError {
    #[error("invalid token")]
    Invalid,
    #[error("wrong token type")]
    WrongType,
}

pub fn sign_store_customer_token(
    customer_id: Uuid,
    secret: &[u8],
) -> Result<String, jsonwebtoken::errors::Error> {
    let now = Utc::now();
    let exp = now + Duration::days(30);
    let claims = Claims {
        sub: customer_id.to_string(),
        exp: exp.timestamp(),
        iat: now.timestamp(),
        typ: TOKEN_TYP.to_string(),
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret),
    )
}

pub fn verify_store_customer_token(
    token: &str,
    secret: &[u8],
) -> Result<Uuid, StoreCustomerJwtError> {
    let mut validation = Validation::default();
    validation.validate_exp = true;
    let data = decode::<Claims>(token.trim(), &DecodingKey::from_secret(secret), &validation)
        .map_err(|_| StoreCustomerJwtError::Invalid)?;
    if data.claims.typ != TOKEN_TYP {
        return Err(StoreCustomerJwtError::WrongType);
    }
    Uuid::parse_str(&data.claims.sub).map_err(|_| StoreCustomerJwtError::Invalid)
}
