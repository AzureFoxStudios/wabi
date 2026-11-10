//! `wabidb-cli` — read-only operator inspection of a WabiDB engine directory.
//!
//! Usage:
//!   wabidb-cli check         <DATA_DIR>
//!   wabidb-cli verify        <DATA_DIR>
//!   wabidb-cli status        <DATA_DIR>
//!   wabidb-cli list-streams  <DATA_DIR>
//!
//! `DATA_DIR` is the engine directory (the one holding
//! `storage-manifest.json`, e.g. `data/wabi-server/wabidb`). Reports are
//! printed in Debug format; exit code is 0 on success, 1 on failure, 2 on a
//! usage error. `check` and `verify` also exit 1 when their report is not ok.
//!
//! Every command only reads. They are meant for a stopped server or a copy
//! of the data directory: a running server may be mid-write. None opens the
//! engine, and none takes, writes or unlinks the `.lock` file.

use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "\
usage: wabidb-cli <check|verify|status|list-streams> <DATA_DIR>

DATA_DIR is the engine directory, e.g. data/wabi-server/wabidb.
Read-only: meant for a stopped server or a copy of the data directory.
Never takes, writes or unlinks the .lock file.

  check         scan every segment and the commit index
  verify        parse storage-manifest.json and verify every segment
  status        counts and sizes from the segments and commit index
  list-streams  one entry per stream directory, with its resolved stream id";

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let (cmd, data_dir) = match args.as_slice() {
        [_, cmd, dir] => (cmd.as_str(), PathBuf::from(dir)),
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };

    let result = match cmd {
        "check" => wabidb::cli::check::check(&data_dir)
            .await
            .map(|r| (r.ok, format!("{r:#?}"))),
        "verify" => wabidb::cli::verify::verify(&data_dir)
            .await
            .map(|r| (r.ok, format!("{r:#?}"))),
        "status" => wabidb::cli::status::status(&data_dir)
            .await
            .map(|r| (true, format!("{r:#?}"))),
        "list-streams" => wabidb::cli::list_streams::list_streams(&data_dir)
            .await
            .map(|r| (true, format!("{r:#?}"))),
        other => {
            eprintln!("unknown command: {other}");
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };

    match result {
        Ok((ok, report)) => {
            println!("{report}");
            if ok {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(e) => {
            eprintln!("wabidb-cli {cmd} failed: {e:?}");
            ExitCode::FAILURE
        }
    }
}
