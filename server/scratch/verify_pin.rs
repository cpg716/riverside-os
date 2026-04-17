use argon2::{
    password_hash::{PasswordHash, PasswordVerifier},
    Argon2,
};

fn main() {
    let pin = "1234";
    let stored = "$argon2id$v=19$m=19456,t=2,p=1$KWJoKjtQYNuPjRIyKL2M9g$FBpoET53ejevTU5LrsLTzQMrgXpV5NavqruJmerdPsc";
    
    let parsed = PasswordHash::new(stored).unwrap();
    let result = Argon2::default().verify_password(pin.as_bytes(), &parsed);
    
    println!("Matches: {:?}", result.is_ok());
}
