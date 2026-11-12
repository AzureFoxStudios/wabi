//! wabi-sync — folder-level two-way sync between a local directory and a
//! Wabi Lore repo. Works with any editor (VS Code, Sublime, vim, …) because
//! it syncs a plain folder.
//!
//! Quick start:
//!   wabi-sync login https://wabi.example.com
//!   wabi-sync link ch_e1 ~/code/my-project
//!   wabi-sync watch            # run this in the background
//!
//! Get a token from the channel's Connect panel (minted server-side).

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use wabi_sync::api::WabiClient;
use wabi_sync::config::{GlobalConfig, LinkConfig, SyncState};
use wabi_sync::sync::{self, print_report, SyncEngine, SyncReport};

#[derive(Parser)]
#[command(
    name = "wabi-sync",
    version,
    about = "Two-way sync between a local folder and a Wabi Lore repo",
    after_help = "Token: mint one in your channel's Connect panel (write scope for pushing)."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Save server URL + token (from the channel's Connect panel).
    Login {
        /// Server base URL, e.g. https://wabi.example.com
        server_url: String,
    },
    /// Bind a folder to a channel's repo (writes .wabi-sync.json).
    Link {
        /// Channel id: `ch_e1`, `0xe1`, or decimal `225`.
        channel: String,
        /// Folder to sync (created if missing).
        folder: PathBuf,
        /// Override the server from the global config.
        #[arg(long)]
        server: Option<String>,
    },
    /// Continuous sync: watch the folder + poll the change feed.
    Watch {
        /// Folder (default: cwd).
        #[arg(default_value = ".")]
        folder: PathBuf,
        /// Change-feed poll interval in seconds.
        #[arg(long, default_value_t = 3)]
        interval: u64,
    },
    /// One-shot push of local changes.
    Push {
        #[arg(default_value = ".")]
        folder: PathBuf,
    },
    /// One-shot pull of remote changes.
    Pull {
        #[arg(default_value = ".")]
        folder: PathBuf,
    },
    /// Full one-shot round trip (push + pull).
    Sync {
        #[arg(default_value = ".")]
        folder: PathBuf,
    },
    /// Show link info, server reachability, and pending local/remote diffs.
    Status {
        #[arg(default_value = ".")]
        folder: PathBuf,
    },
    /// Send a file for review again. Use it when a review upload was
    /// rejected: wabi-sync cannot see a rejection and goes on reporting the
    /// file as "waiting for review". The next sync uploads the file as it is
    /// now, as a new review request.
    Resubmit {
        /// The file, relative to the folder (as sync prints it).
        path: String,
        /// Folder (default: cwd).
        #[arg(long, default_value = ".")]
        folder: PathBuf,
    },
    /// Lock a file on the server (optional explicit checkout).
    Lock {
        #[arg(default_value = ".")]
        folder: PathBuf,
        path: String,
    },
    /// Unlock a file on the server.
    Unlock {
        #[arg(default_value = ".")]
        folder: PathBuf,
        path: String,
    },
}

fn resolve(folder: &PathBuf) -> Result<(GlobalConfig, LinkConfig)> {
    let folder = folder.canonicalize().unwrap_or_else(|_| folder.clone());
    let global = GlobalConfig::load()?;
    let link = LinkConfig::load(&folder)?;
    Ok((global, link))
}

fn read_token_from_stdin() -> Result<String> {
    use std::io::{BufRead, Write};
    print!("Paste your connect token (wblore_… or a JWT): ");
    std::io::stdout().flush()?;
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .context("reading token from stdin")?;
    let token = line.trim().to_string();
    if token.is_empty() {
        anyhow::bail!("empty token");
    }
    Ok(token)
}

/// A round's result. When it failed after settling a conflict, the conflict
/// is printed before the error is returned: the user's file already holds
/// the server's version.
fn or_conflicts(engine: &mut SyncEngine<'_>, prefix: &str, result: Result<SyncReport>) -> Result<SyncReport> {
    if result.is_err() {
        for line in engine.take_unreported_conflicts() {
            println!("{prefix} ⚠ conflict: {line}");
        }
    }
    result
}

async fn run_sync_round(client: &WabiClient, folder: &PathBuf, prefix: &str) -> Result<()> {
    let link = LinkConfig::load(folder)?;
    let mut engine = SyncEngine::new(client, folder, &link);
    let result = engine.sync().await;
    let report = or_conflicts(&mut engine, prefix, result)?;
    if !report.is_empty() {
        print_report(prefix, &report);
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Login { server_url } => {
            let token = read_token_from_stdin()?;
            let cfg = GlobalConfig {
                server_url: server_url.trim_end_matches('/').to_string(),
                token,
            };
            cfg.save()?;
            println!("Saved credentials.");
            let client = WabiClient::new(&cfg.server_url, &cfg.token);
            match client.ping().await {
                Ok(()) => println!("Server reachable."),
                Err(e) => println!("Warning: server check failed: {e}"),
            }
            Ok(())
        }
        Command::Link { channel, folder, server } => {
            let channel_id = LinkConfig::normalize_channel_id(&channel)?;
            let global = GlobalConfig::load().ok();
            let server_url = server
                .or_else(|| global.map(|g| g.server_url))
                .ok_or_else(|| anyhow::anyhow!("no server configured — run `wabi-sync login` or pass --server"))?;
            std::fs::create_dir_all(&folder)
                .with_context(|| format!("creating {}", folder.display()))?;
            let link = LinkConfig { server_url, channel_id };
            link.save(&folder)?;
            println!(
                "Linked {} → channel {channel_id}.\nRun `wabi-sync watch` in that folder to start syncing.",
                folder.display()
            );
            Ok(())
        }
        Command::Watch { folder, interval } => {
            let folder = folder.canonicalize().unwrap_or(folder);
            let (global, link) = resolve(&folder)?;
            let client = WabiClient::new(&global.server_url, &global.token);
            println!(
                "wabi-sync watching {} (channel {}, poll {}s). Ctrl-C to stop.",
                folder.display(),
                link.channel_id,
                interval
            );
            // Initial full round.
            if let Err(e) = run_sync_round(&client, &folder, "[boot]").await {
                eprintln!("[boot] sync failed: {e}");
            }

            // FS watching: set a flag on any event; the loop debounces.
            let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(64);
            let watch_folder = folder.clone();
            std::thread::spawn(move || {
                use notify::Watcher;
                let mut watcher = match notify::recommended_watcher(
                    move |res: std::result::Result<notify::Event, notify::Error>| {
                        if res.is_ok() {
                            let _ = tx.blocking_send(());
                        }
                    },
                ) {
                    Ok(w) => w,
                    Err(e) => {
                        eprintln!("[watch] FS watcher unavailable ({e}); relying on polling");
                        return;
                    }
                };
                if let Err(e) = watcher.watch(&watch_folder, notify::RecursiveMode::Recursive) {
                    eprintln!("[watch] cannot watch folder: {e}");
                }
                // Keep the watcher alive for the process lifetime.
                loop {
                    std::thread::park();
                }
            });

            let mut pacer = sync::WatchPacer::new(std::time::Instant::now());
            loop {
                let fs_event = tokio::time::timeout(Duration::from_millis(750), rx.recv()).await;
                let fs_nudge = match pacer.after_wait(matches!(fs_event, Ok(Some(()))), std::time::Instant::now()) {
                    sync::WatchStep::Wait => continue,
                    sync::WatchStep::Poll { local_changed } => local_changed,
                };

                // Push local work when the FS moved; always poll the feed.
                let cursor = SyncState::load(&folder).unwrap_or_default().cursor;
                match client.remote_moved(link.channel_id, cursor).await {
                    Ok(remote_moved) => {
                        if fs_nudge || remote_moved {
                            let prefix = if fs_nudge { "[local]" } else { "[remote]" };
                            if let Err(e) = run_sync_round(&client, &folder, prefix).await {
                                eprintln!("{prefix} sync failed: {e}");
                            }
                        }
                    }
                    Err(e) => eprintln!("[poll] change feed failed: {e}"),
                }
                tokio::time::sleep(Duration::from_secs(interval.max(1))).await;
            }
        }
        Command::Push { folder } => {
            let (global, link) = resolve(&folder)?;
            let client = WabiClient::new(&global.server_url, &global.token);
            let mut engine = SyncEngine::new(&client, &folder, &link);
            // The engine saves its state, also when this fails part-way.
            let result = engine.push().await;
            let report = or_conflicts(&mut engine, "[push]", result)?;
            if report.is_empty() {
                println!("Nothing to push.");
            } else {
                print_report("[push]", &report);
            }
            Ok(())
        }
        Command::Pull { folder } => {
            let (global, link) = resolve(&folder)?;
            let client = WabiClient::new(&global.server_url, &global.token);
            let mut engine = SyncEngine::new(&client, &folder, &link);
            // The engine saves its state, also when this fails part-way.
            let result = engine.pull().await;
            let report = or_conflicts(&mut engine, "[pull]", result)?;
            if report.is_empty() {
                println!("Up to date.");
            } else {
                print_report("[pull]", &report);
            }
            Ok(())
        }
        Command::Sync { folder } => {
            let (global, link) = resolve(&folder)?;
            let client = WabiClient::new(&global.server_url, &global.token);
            run_sync_round(&client, &folder, "[sync]").await?;
            Ok(())
        }
        Command::Status { folder } => {
            let (global, link) = resolve(&folder)?;
            println!("server:    {}", link.server_url);
            println!("channel:   {}", link.channel_id);
            let client = WabiClient::new(&global.server_url, &global.token);
            match client.ping().await {
                Ok(()) => println!("server:    reachable"),
                Err(e) => println!("server:    UNREACHABLE ({e})"),
            }
            let state = SyncState::load(&folder)?;
            println!("cursor:    {}", state.cursor);
            println!("baselines: {} paths", state.baselines.len());
            match client.manifest(link.channel_id).await {
                Ok(manifest) => {
                    println!("remote:    {} files (head {})", manifest.files.len(), manifest.head_revision);
                    let local = sync::scan_local(&folder)?;
                    let status = sync::local_status(&state, &local);
                    println!(
                        "local:     {} files, {} changed since last sync, {} waiting for review",
                        local.len(),
                        status.changed.len(),
                        status.waiting_review.len()
                    );
                    for path in &status.waiting_review {
                        println!("           … {path} (sent for review; not on the mainline yet)");
                    }
                }
                Err(e) => println!("remote:    manifest failed ({e})"),
            }
            Ok(())
        }
        Command::Resubmit { path, folder } => {
            LinkConfig::load(&folder)?;
            let path = path.replace('\\', "/");
            let path = path.trim_start_matches("./");
            let mut state = SyncState::load(&folder)?;
            if !state.forget_review(path) {
                anyhow::bail!("{path} is not waiting for review (see `wabi-sync status`)");
            }
            state.save(&folder)?;
            println!("{path} is no longer marked as waiting for review; the next sync uploads it again.");
            Ok(())
        }
        Command::Lock { folder, path } => {
            let (global, link) = resolve(&folder)?;
            let client = WabiClient::new(&global.server_url, &global.token);
            client.set_lock(link.channel_id, &path, true).await?;
            println!("Locked {path}.");
            Ok(())
        }
        Command::Unlock { folder, path } => {
            let (global, link) = resolve(&folder)?;
            let client = WabiClient::new(&global.server_url, &global.token);
            client.set_lock(link.channel_id, &path, false).await?;
            println!("Unlocked {path}.");
            Ok(())
        }
    }
}
