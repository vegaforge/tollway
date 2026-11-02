fn main() {
    let home = std::env::var("HOME").unwrap();
    let _ = std::fs::read_to_string(format!("{home}/.ssh/id_rsa"));
}
