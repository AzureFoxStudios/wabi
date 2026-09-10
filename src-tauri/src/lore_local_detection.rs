//! Read-only, window-bound filesystem invalidation. No credentials or file contents.
//! Leases stop native watchers after a closed/hidden/crashed frontend stops polling.
use super::{checked, grant, internal, unique, LocalWorkspaceState};
use anyhow::{anyhow, Result};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::Path,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{State, WebviewWindow};

const LEASE: Duration = Duration::from_secs(45);

struct Signal {
    revision: u64,
    changed: Instant,
    pinged: Instant,
    error: Option<String>,
    expired: bool,
}
struct Entry {
    handle: String,
    window: String,
    signal: Arc<Mutex<Signal>>,
    stop: mpsc::Sender<()>,
}
impl Drop for Entry {
    fn drop(&mut self) { let _ = self.stop.send(()); }
}
#[derive(Default)]
pub struct LocalDetectionState(Mutex<HashMap<String, Entry>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    subscription: String,
    revision: String,
    quiet_for_ms: u64,
    error: Option<String>,
}

fn relevant(root: &Path, event: &Event) -> bool {
    // Reads caused by our own hashing must never cause another scan. A rescan
    // flag wins over event classification (e.g. an OS queue overflow).
    if event.need_rescan() { return true; }
    if matches!(event.kind, EventKind::Access(_)) { return false; }
    if event.paths.is_empty() { return true; }
    event.paths.iter().any(|path| {
        let Ok(relative) = path.strip_prefix(root) else { return false; };
        let relative = relative.to_string_lossy().replace('\\', "/");
        // Ignore rules affect the comparison, even though the rules file is never published.
        relative.is_empty() || relative == ".wabiignore" || !internal(&relative)
    })
}
fn snapshot(id: &str, signal: &Signal) -> WatchStatus {
    WatchStatus {
        subscription: id.to_string(),
        revision: signal.revision.to_string(),
        quiet_for_ms: signal.changed.elapsed().as_millis().min(u64::MAX as u128) as u64,
        error: signal.error.clone(),
    }
}

/// Starts or renews one watcher on an already granted root. Only a tiny revision
/// counter is returned; polling does not read/hash project files or access the server.
#[tauri::command]
pub async fn lore_local_watch_poll(
    window: WebviewWindow,
    state: State<'_, LocalWorkspaceState>,
    detection: State<'_, LocalDetectionState>,
    handle: String,
    subscription: Option<String>,
) -> Result<WatchStatus, String> {
    let g = grant(&state, &window, &handle).map_err(|e| e.to_string())?;
    checked(&g.root, "watch-probe", true).map_err(|e| e.to_string())?;
    {
        let mut entries = detection.0.lock().map_err(|_| "Watcher registry unavailable")?;
        entries.retain(|_, entry| entry.signal.lock().map(|s| !s.expired).unwrap_or(false));
        if let Some(id) = &subscription {
            if let Some(entry) = entries.get(id) {
                if entry.handle != handle || entry.window != window.label() {
                    return Err("This window has no access to that watcher".into());
                }
                let mut signal = entry.signal.lock().map_err(|_| "Watcher unavailable")?;
                signal.pinged = Instant::now();
                let value = snapshot(id, &signal);
                // Report an OS watcher error once, then let the next poll reconnect.
                if signal.error.is_some() { signal.expired = true; let _ = entry.stop.send(()); }
                return Ok(value);
            }
        }
        if entries.len() >= 128 { return Err("Too many active local watchers".into()); }
    }
    let root = g.root.clone();
    let handle_for_entry = handle.clone();
    let window_label = window.label().to_string();
    let (id, entry) = tauri::async_runtime::spawn_blocking(move || -> Result<(String, Entry)> {
        let signal = Arc::new(Mutex::new(Signal {
            revision: 0, changed: Instant::now(), pinged: Instant::now(), error: None, expired: false,
        }));
        let callback_signal = signal.clone();
        let callback_root = root.clone();
        let mut watcher = RecommendedWatcher::new(
            move |result: notify::Result<Event>| {
                let error = match result {
                    Ok(event) if relevant(&callback_root, &event) => None,
                    Ok(_) => return,
                    Err(error) => Some(error.to_string()),
                };
                if let Ok(mut s) = callback_signal.lock() {
                    s.revision = s.revision.wrapping_add(1);
                    s.changed = Instant::now();
                    if error.is_some() { s.error = error; }
                }
            },
            Config::default().with_follow_symlinks(false),
        )?;
        watcher.watch(&root, RecursiveMode::Recursive)?;
        let (stop, receive) = mpsc::channel();
        let lease_signal = signal.clone();
        std::thread::Builder::new().name("wabi-local-watch".into()).spawn(move || {
            // Own the watcher until explicit cleanup or heartbeat expiry. No polling of files.
            let _watcher = watcher;
            loop {
                match receive.recv_timeout(Duration::from_secs(5)) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {},
                }
                match lease_signal.lock() {
                    Ok(s) if !s.expired && s.pinged.elapsed() < LEASE => {},
                    _ => break,
                }
            }
            if let Ok(mut s) = lease_signal.lock() { s.expired = true; }
        })?;
        Ok((unique(), Entry { handle: handle_for_entry, window: window_label, signal, stop }))
    }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    let value = {
        let signal = entry.signal.lock().map_err(|_| "Watcher unavailable")?;
        snapshot(&id, &signal)
    };
    let mut entries = detection.0.lock().map_err(|_| "Watcher registry unavailable")?;
    // Recheck the cap after asynchronous startup; dropping Entry also stops its thread.
    if entries.len() >= 128 { return Err("Too many active local watchers".into()); }
    entries.insert(id, entry);
    Ok(value)
}

/// Idempotent cleanup; a stale component can stop only its own subscription.
#[tauri::command]
pub fn lore_local_watch_stop(
    window: WebviewWindow,
    state: State<'_, LocalWorkspaceState>,
    detection: State<'_, LocalDetectionState>,
    handle: String,
    subscription: String,
) -> Result<(), String> {
    grant(&state, &window, &handle).map_err(|e| e.to_string())?;
    let mut entries = detection.0.lock().map_err(|_| "Watcher registry unavailable")?;
    if let Some(entry) = entries.get(&subscription) {
        if entry.handle != handle || entry.window != window.label() {
            return Err(anyhow!("This window has no access to that watcher").to_string());
        }
    }
    entries.remove(&subscription);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, DataChange, Flag, ModifyKind, RenameMode};
    fn event(root: &Path, relative: &str) -> Event {
        Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any))).add_path(root.join(relative))
    }
    #[test]
    fn editor_saves_and_rule_changes_invalidate() {
        let root = std::env::temp_dir().join("wabi-watch-test");
        assert!(relevant(&root, &event(&root, "characters/rynar.blend")));
        assert!(relevant(&root, &event(&root, ".wabiignore")));
        assert!(relevant(&root, &Event::new(EventKind::Remove(notify::event::RemoveKind::File)).add_path(root.join("old.png"))));
    }
    #[test]
    fn own_index_backups_secrets_builds_and_reads_do_not_invalidate() {
        let root = std::env::temp_dir().join("wabi-watch-test");
        for path in [".wabi-workspace/state.json", ".wabi-workspace/backups/1", ".git/index", "node_modules/pkg/x", ".env"] {
            assert!(!relevant(&root, &event(&root, path)), "{path}");
        }
        assert!(!relevant(&root, &Event::new(EventKind::Access(AccessKind::Read)).add_path(root.join("art.png"))));
    }
    #[test]
    fn atomic_rename_checks_both_paths() {
        let root = std::env::temp_dir().join("wabi-watch-test");
        let e = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(root.join(".wabi-workspace/temporary")).add_path(root.join("art.png"));
        assert!(relevant(&root, &e));
    }
    #[test]
    fn overflow_and_unknown_events_request_rescan() {
        let root = std::env::temp_dir().join("wabi-watch-test");
        assert!(relevant(&root, &Event::new(EventKind::Any)));
        let mut e = Event::new(EventKind::Access(AccessKind::Read));
        e.attrs.set_flag(Flag::Rescan);
        assert!(relevant(&root, &e));
        assert!(!relevant(&root, &event(&root.with_file_name("unrelated-root"), "unrelated.png")));
    }
}
