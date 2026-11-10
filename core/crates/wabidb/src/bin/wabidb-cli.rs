//! `wabidb-cli` — operator inspection and repair of a WabiDB engine directory.
//!
//! Usage:
//!   wabidb-cli check         <DATA_DIR>
//!   wabidb-cli verify        <DATA_DIR>
//!   wabidb-cli status        <DATA_DIR>
//!   wabidb-cli list-streams  <DATA_DIR>
//!   wabidb-cli quarantine --seq <N> <DATA_DIR>
//!
//! `DATA_DIR` is the engine directory (the one holding
//! `storage-manifest.json`, e.g. `data/wabi-server/wabidb`). Reports are
//! printed in Debug format; exit code is 0 on success, 1 on failure, 2 on a
//! usage error. `check` and `verify` also exit 1 when their report is not ok.
//!
//! `check`, `verify`, `status` and `list-streams` only read. They are meant
//! for a stopped server or a copy of the data directory: a running server
//! may be mid-write. None of them opens the engine, and none takes, writes
//! or unlinks the `.lock` file.
//!
//! `quarantine` is the one command that writes. It takes the engine's
//! advisory lock (`.lock`) for as long as it runs, so it fails against a
//! running server, and adds commit N to `global/quarantine.json`; the next
//! startup skips that commit. It never creates or unlinks `.lock`. Copy the
//! data directory first (docs/deployment/BACKUP_AND_RECOVERY.md).

use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "\
usage: wabidb-cli <check|verify|status|list-streams> <DATA_DIR>
       wabidb-cli quarantine --seq <N> <DATA_DIR>

DATA_DIR is the engine directory, e.g. data/wabi-server/wabidb.

Read-only (meant for a stopped server or a copy of the data directory;
never takes, writes or unlinks the .lock file):
  check         scan every segment and the commit index
  verify        parse storage-manifest.json and verify every segment
  status        counts and sizes from the segments and commit index
  list-streams  one entry per stream directory, with its resolved stream id

Writes (stop the server and copy the data directory first):
  quarantine    add commit N to global/quarantine.json so startup skips it;
                N is the commit a failed startup names. Takes the .lock
                advisory lock while it runs, so it fails if the server is
                running. Never creates or unlinks .lock.";

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let (cmd, data_dir, seq) = match args.as_slice() {
        [_, cmd, flag, seq, dir] if cmd == "quarantine" && flag == "--seq" => {
            match seq.parse::<u64>() {
                Ok(seq) => (cmd.as_str(), PathBuf::from(dir), Some(seq)),
                Err(_) => {
                    eprintln!("--seq must be a commit sequence number, got {seq:?}");
                    eprintln!("{USAGE}");
                    return ExitCode::from(2);
                }
            }
        }
        [_, cmd, dir] if cmd != "quarantine" => (cmd.as_str(), PathBuf::from(dir), None),
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };

    let result = match (cmd, seq) {
        ("check", None) => wabidb::cli::check::check(&data_dir)
            .await
            .map(|r| (r.ok, format!("{r:#?}"))),
        ("verify", None) => wabidb::cli::verify::verify(&data_dir)
            .await
            .map(|r| (r.ok, format!("{r:#?}"))),
        ("status", None) => wabidb::cli::status::status(&data_dir)
            .await
            .map(|r| (true, format!("{r:#?}"))),
        ("list-streams", None) => wabidb::cli::list_streams::list_streams(&data_dir)
            .await
            .map(|r| (true, format!("{r:#?}"))),
        ("quarantine", Some(seq)) => {
            wabidb::cli::quarantine::quarantine(&data_dir, seq).map(|r| (true, format!("{r:#?}")))
        }
        (other, _) => {
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
