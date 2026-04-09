//! One-off: `cargo run --example hash_pin_once -- 1234` prints Argon2 hash for migration seeds.
use riverside_server::auth::pins::hash_pin;
use std::env;

fn main() {
    let pin = env::args().nth(1).unwrap_or_else(|| "1234".to_string());
    match hash_pin(&pin) {
        Ok(h) => println!("{h}"),
        Err(e) => {
            eprintln!("{e:?}");
            std::process::exit(1);
        }
    }
}
