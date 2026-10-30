// Test cases for proc-macro.yaml. Harmless samples: nothing here is executed.
use proc_macro::TokenStream;

#[proc_macro_derive(Storage)]
pub fn derive_storage(input: TokenStream) -> TokenStream {
    // ruleid: rust-proc-macro-side-effects
    let _ = std::fs::read_to_string("/home/user/.ssh/id_ed25519");
    // ruleid: rust-proc-macro-side-effects
    let _ = std::process::Command::new("curl").status();
    // ok: rust-proc-macro-side-effects
    let parsed = input.to_string();
    parsed.parse().unwrap()
}

// A helper outside a macro entry point is ordinary code.
fn helper() {
    // ok: rust-proc-macro-side-effects
    let _ = std::fs::read_to_string("Cargo.toml");
}
