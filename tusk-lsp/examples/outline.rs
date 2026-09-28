//! Prints `tusk/phpOutline`'s answer for each PHP file named on the command line, as `<file>.outline.json` beside
//! it. The editor's tests of the designers read these: `cargo run --example outline -- ../src/fixtures/*.php`.

fn main() {
    for path in std::env::args().skip(1) {
        let text = std::fs::read_to_string(&path).expect("read the file");
        let json = serde_json::to_string_pretty(&tusk_lsp::features::outline::outline_of(&text)).expect("outline as JSON");
        std::fs::write(format!("{}.outline.json", path.trim_end_matches(".php")), json + "\n").expect("write the outline");
    }
}
