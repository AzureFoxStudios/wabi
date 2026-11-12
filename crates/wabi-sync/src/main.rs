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
use wabi_sync::config::{FolderLock, GlobalConfig, LinkConfig, Linked, StateOwner, SyncState};
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
        /// The folder's sync state was recorded for another address of this
        /// same server and repository: keep it and go on with it. Without
        /// this, state recorded for another server or channel is moved aside
        /// and the folder starts as newly linked.
        #[arg(long)]
        keep_state: bool,
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
        /// Go ahead although this deletes most of the synced files on one
        /// side (without it such a round stops and says why).
        #[arg(long)]
        allow_mass_delete: bool,
    },
    /// One-shot pull of remote changes.
    Pull {
        #[arg(default_value = ".")]
        folder: PathBuf,
        /// Go ahead although this deletes most of the synced files on one
        /// side (without it such a round stops and says why).
        #[arg(long)]
        allow_mass_delete: bool,
    },
    /// Full one-shot round trip (push + pull).
    Sync {
        #[arg(default_value = ".")]
        folder: PathBuf,
        /// Go ahead although this deletes most of the synced files on one
        /// side (without it such a round stops and says why).
        #[arg(long)]
        allow_mass_delete: bool,
    },
    /// Show link info, server reachability, and pending local/remote diffs.
    Status {
        #[arg(default_value = ".")]
        folder: PathBuf,
    },
    /// Send a file again. Use it when a review upload was rejected:
    /// wabi-sync cannot see a rejection and goes on reporting the file as
    /// "waiting for review". The next sync uploads the file as it is now,
    /// as a new review request. Also use it for a file the server refused,
    /// once the reason is gone: an unchanged refused file is not sent again
    /// by itself.
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
        for line in engine.take_notices() {
            println!("{prefix} note: {line}");
        }
        for line in engine.take_unreported_conflicts() {
            println!("{prefix} ⚠ conflict: {line}");
        }
    }
    result
}

async fn run_sync_round(client: &WabiClient, folder: &PathBuf, prefix: &str, allow_mass_delete: bool) -> Result<()> {
    let link = LinkConfig::load(folder)?;
    let mut engine = SyncEngine::new(client, folder, &link)?;
    engine.allow_mass_delete |= allow_mass_delete;
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
        Command::Link { channel, folder, server, keep_state } => {
            let channel_id = LinkConfig::normalize_channel_id(&channel)?;
            let global = GlobalConfig::load().ok();
            // Rounds talk to the server of the login; that is whose state it is.
            let client_url = global.as_ref().map(|g| g.server_url.clone());
            let server_url = server
                .or_else(|| client_url.clone())
                .ok_or_else(|| anyhow::anyhow!("no server configured — run `wabi-sync login` or pass --server"))?;
            std::fs::create_dir_all(&folder)
                .with_context(|| format!("creating {}", folder.display()))?;
            let owner = StateOwner::new(client_url.as_deref().unwrap_or(&server_url), channel_id);
            let link = LinkConfig { server_url, channel_id };
            match link.link(&folder, &owner, keep_state)? {
                Linked::Unchanged => {
                    println!("{} is already linked to channel {channel_id}; nothing changed.", folder.display());
                    return Ok(());
                }
                Linked::New | Linked::Replaced { state_moved_to: None, .. } => {}
                Linked::KeptState { previous } => println!(
                    "The sync state recorded for {} channel {} is kept, and is now recorded for {} channel {}.",
                    previous.server_url, previous.channel_id, owner.server_url, owner.channel_id
                ),
                Linked::Replaced { state_moved_to: Some(moved), .. } => println!(
                    "This folder had sync state for another link. It was moved to {} and is not used: the next \
                     sync treats the folder as newly linked. It deletes nothing on either side, uploads files \
                     the repo does not have, and keeps a file that differs from the repo's as a conflict copy. \
                     If that state was for this same repository under another address, move it back to \
                     .wabi-sync/state.json and run `wabi-sync link {channel} {} --keep-state` instead.",
                    moved.display(),
                    folder.display()
                ),
            }
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
            if let Err(e) = run_sync_round(&client, &folder, "[boot]", false).await {
                eprintln!("[boot] sync failed: {e}");
            }

            // FS watching: set a flag on any event; the loop debounces.
            let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(64);
            let watch_folder = folder.clone();
            let event_root = folder.clone();
            std::thread::spawn(move || {
                use notify::Watcher;
                let mut watcher = match notify::recommended_watcher(
                    move |res: std::result::Result<notify::Event, notify::Error>| {
                        // A file being opened or read is not a change, and
                        // neither is the client writing its own state.
                        if res.is_ok_and(|event| !event.kind.is_access() && sync::is_user_change(&event_root, &event.paths)) {
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
                let local_changed = match pacer.after_wait(matches!(fs_event, Ok(Some(()))), std::time::Instant::now()) {
                    sync::WatchStep::Wait => continue,
                    sync::WatchStep::Poll { local_changed } => local_changed,
                };

                // Push local work when the FS moved; always poll the feed.
                let cursor = match SyncState::load(&folder) {
                    Ok(state) => state.cursor,
                    Err(e) => {
                        eprintln!("[watch] {e}");
                        tokio::time::sleep(Duration::from_secs(interval.max(1))).await;
                        continue;
                    }
                };
                match client.remote_moved(link.channel_id, cursor).await {
                    Ok(remote_moved) => {
                        if local_changed || remote_moved {
                            let prefix = if local_changed { "[local]" } else { "[remote]" };
                            let round = run_sync_round(&client, &folder, prefix, false).await;
                            if let Err(e) = &round {
                                eprintln!("{prefix} sync failed: {e}");
                            }
                            // A local change whose round failed is tried
                            // again after the next poll.
                            pacer.round_ran(round.is_ok());
                        }
                    }
                    Err(e) => eprintln!("[poll] change feed failed: {e}"),
                }
                tokio::time::sleep(Duration::from_secs(interval.max(1))).await;
            }
        }
        Command::Push { folder, allow_mass_delete } => {
            let (global, link) = resolve(&folder)?;
            let client = WabiClient::new(&global.server_url, &global.token);
            let mut engine = SyncEngine::new(&client, &folder, &link)?;
            engine.allow_mass_delete |= allow_mass_delete;
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
        Command::Pull { folder, allow_mass_delete } => {
            let (global, link) = resolve(&folder)?;
            let client = WabiClient::new(&global.server_url, &global.token);
            let mut engine = SyncEngine::new(&client, &folder, &link)?;
            engine.allow_mass_delete |= allow_mass_delete;
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
        Command::Sync { folder, allow_mass_delete } => {
            let (global, _link) = resolve(&folder)?;
            let client = WabiClient::new(&global.server_url, &global.token);
            run_sync_round(&client, &folder, "[sync]", allow_mass_delete).await?;
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
            let state = match SyncState::for_owner(&folder, StateOwner::new(&global.server_url, link.channel_id)) {
                Ok(state) => state,
                Err(e) => {
                    println!("state:     {e:#}");
                    return Ok(());
                }
            };
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
            let (global, link) = resolve(&folder)?;
            let path = path.replace('\\', "/");
            let path = path.trim_start_matches("./");
            // Not while a round is reading and writing the same state.
            let _lock = FolderLock::acquire(&folder)?;
            let mut state = SyncState::for_owner(&folder, StateOwner::new(&global.server_url, link.channel_id))?;
            let was_waiting = state.forget_review(path);
            let was_refused = state.refused_uploads.remove(path).is_some();
            if !was_waiting && !was_refused {
                anyhow::bail!("{path} is neither waiting for review nor refused by the server (see `wabi-sync status`)");
            }
            state.save(&folder)?;
            if was_waiting {
                println!("{path} is no longer marked as waiting for review; the next sync uploads it again.");
            } else {
                println!("{path} is no longer marked as refused; the next sync uploads it again.");
            }
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
