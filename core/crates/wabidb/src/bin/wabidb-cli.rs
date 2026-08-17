//! `wabidb-cli` — operator entry point for the storage CLI tools.
//!
//! Usage:
//!   wabidb-cli check    <DATA_DIR>
//!   wabidb-cli verify   <DATA_DIR>
//!   wabidb-cli status   <DATA_DIR>
//!
//! Reports are printed in Debug format; exit code is 0 on success, 1 on
//! failure. Run while the server is STOPPED for consistent results (the
//! engine lock is not taken; these commands only read).

use std::path::PathBuf;
use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let (cmd, data_dir) = match args.as_slice() {
        [_, cmd, dir] => (cmd.as_str(), PathBuf::from(dir)),
        _ => {
            eprintln!("usage: wabidb-cli <check|verify|status> <DATA_DIR>");
            return ExitCode::from(2);
        }
    };

    let result = match cmd {
        "check" => wabidb::cli::check::check(&data_dir).await.map(|r| format!("{r:#?}")),
        "verify" => wabidb::cli::verify::verify(&data_dir).await.map(|r| format!("{r:#?}")),
        "status" => wabidb::cli::status::status(&data_dir).await.map(|r| format!("{r:#?}")),
        other => {
            eprintln!("unknown command: {other}");
            eprintln!("usage: wabidb-cli <check|verify|status> <DATA_DIR>");
            return ExitCode::from(2);
        }
    };

    match result {
        Ok(report) => {
            println!("{report}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("wabidb-cli {cmd} failed: {e:?}");
            ExitCode::FAILURE
        }
    }
}
