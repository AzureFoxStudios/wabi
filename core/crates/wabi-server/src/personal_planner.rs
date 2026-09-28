//! Private desktop Planner IPC. No listener, community, account or provider.
//! Immutable, versioned JSON commits preserve the prior snapshot on interruption.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

const LIMIT: u64 = 24 * 1024 * 1024;
const STATE_LIMIT: usize = 64 * 1024 * 1024;
const SCOPE: &str = "planner:personal-desktop:v1";
type Result<T> = std::result::Result<T, String>;

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    version: u32,
    revision: u64,
    data: Option<Value>,
    drafts: Vec<Value>,
}

fn regular(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if !m.is_file() => Err("Planner storage contains a non-regular file".into()),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
fn options() -> fs::OpenOptions {
    let mut o = fs::OpenOptions::new();
    o.write(true).read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o
}
fn snapshot(value: &Value) -> Result<()> {
    let object = value.as_object().ok_or("Invalid Planner snapshot")?;
    let keys = [
        "todos",
        "calendarEvents",
        "diaryEntries",
        "projects",
        "sprints",
        "kanbanColumns",
        "resources",
        "tags",
        "graphEdges",
    ];
    if object.len() != keys.len() {
        return Err("Planner requires all nine collections".into());
    }
    let mut count = 0;
    for key in keys {
        let rows = object
            .get(key)
            .and_then(Value::as_array)
            .ok_or("Invalid Planner collection")?;
        count += rows.len();
        let mut ids = std::collections::HashSet::new();
        for row in rows {
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.trim() == *s)
                .ok_or("Planner record needs an ID")?;
            if !ids.insert(id) {
                return Err("Duplicate Planner record ID".into());
            }
        }
    }
    if count > 10_000
        || serde_json::to_vec(value).map_err(|e| e.to_string())?.len() > 20 * 1024 * 1024
    {
        return Err("Planner snapshot exceeds the storage limit".into());
    }
    Ok(())
}

pub fn operate(root: &Path, request: Value) -> Result<Value> {
    match fs::symlink_metadata(root) {
        Ok(m) if !m.is_dir() || m.file_type().is_symlink() => {
            return Err("Invalid personal Planner directory".into())
        }
        Ok(_) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(root).map_err(|e| e.to_string())?
        }
        Err(e) => return Err(e.to_string()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let lock_path = root.join("operation.lock");
    regular(&lock_path)?;
    let lock = options()
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|e| e.to_string())?;
    lock.try_lock()
        .map_err(|_| "Personal Planner is busy. Retry saving.".to_string())?;
    let mut commits = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(n) = name
            .strip_prefix("state-")
            .and_then(|s| s.strip_suffix(".json"))
        {
            if n.len() == 20 && n.bytes().all(|b| b.is_ascii_digit()) {
                commits.push((n.parse::<u64>().map_err(|e| e.to_string())?, entry.path()));
            }
        }
    }
    commits.sort_by_key(|c| c.0);
    let mut state = if let Some((_, path)) = commits.last() {
        regular(path)?;
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(|e| e.to_string())?
            .take(STATE_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > STATE_LIMIT {
            return Err("Personal Planner storage exceeds its limit".into());
        }
        let s: State = serde_json::from_slice(&bytes).map_err(|_| "Personal Planner storage is damaged. Restore a backup; it has not been overwritten.".to_string())?;
        if s.version != 1 {
            return Err("Unsupported personal Planner storage version".into());
        }
        if let Some(data) = &s.data {
            snapshot(data)?;
        }
        s
    } else {
        State {
            version: 1,
            ..State::default()
        }
    };
    if request.get("scope").and_then(Value::as_str) != Some(SCOPE) {
        return Err("Invalid personal Planner scope".into());
    }
    match request.get("operation").and_then(Value::as_str) {
        Some("read") => {
            return Ok(state
                .data
                .map(|data| json!({"scope": SCOPE, "revision": state.revision, "data": data}))
                .unwrap_or(Value::Null))
        }
        Some("drafts") => return Ok(json!(state.drafts)),
        Some("write") => (),
        _ => return Err("Unknown personal Planner operation".into()),
    }
    let data = request.get("data").ok_or("Missing Planner snapshot")?;
    snapshot(data)?;
    let revision = request
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or("Missing Planner revision")?;
    let draft = request
        .get("draftId")
        .and_then(Value::as_str)
        .filter(|s| s.len() <= 80 && !s.is_empty())
        .ok_or("Invalid recovery draft ID")?;
    let conflict = revision != state.revision;
    state
        .drafts
        .retain(|d| d.get("id").and_then(Value::as_str) != Some(draft));
    if conflict {
        if state.drafts.len() >= 32 {
            return Err(
                "Recovery storage is full. Export the current draft before retrying.".into(),
            );
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        state
            .drafts
            .push(json!({"scope": SCOPE, "id": draft, "data": data, "savedAt": now as u64}));
    } else {
        if state.revision >= 9_007_199_254_740_991 {
            return Err("Planner revision limit reached".into());
        }
        state.revision += 1;
        state.data = Some(data.clone());
    }
    let bytes = serde_json::to_vec(&state).map_err(|e| e.to_string())?;
    if bytes.len() > STATE_LIMIT {
        return Err("Recovery storage is full. Export your draft.".into());
    }
    let sequence = commits.last().map_or(Ok(1), |c| {
        c.0.checked_add(1).ok_or("Planner commit limit reached")
    })?;
    let pending = root.join("pending.tmp");
    regular(&pending)?;
    let mut file = options()
        .create(true)
        .truncate(true)
        .open(&pending)
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    let destination = root.join(format!("state-{sequence:020}.json"));
    if destination.exists() {
        return Err("Planner commit already exists".into());
    }
    fs::rename(&pending, destination).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    fs::File::open(root)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    // Keep the preceding complete commit; interrupted pending files are ignored.
    for (_, path) in commits.iter().take(commits.len().saturating_sub(1)) {
        let _ = fs::remove_file(path);
    }
    if conflict {
        Err("Planner changed in another window. Your draft is kept; export it before loading the saved version.".into())
    } else {
        Ok(json!(state.revision))
    }
}

pub fn run(root: &Path) -> anyhow::Result<()> {
    let mut input = Vec::new();
    std::io::stdin().take(LIMIT + 1).read_to_end(&mut input)?;
    let result = if input.len() > LIMIT as usize {
        Err("Planner request exceeds its limit".into())
    } else {
        serde_json::from_slice(&input)
            .map_err(|_| "Invalid Planner request".into())
            .and_then(|r| operate(root, r))
    };
    let output = match result {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => json!({"ok":false,"error":error}),
    };
    serde_json::to_writer(std::io::stdout(), &output)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn data(title: &str) -> Value {
        json!({"todos":[{"id":"task","title":title}],"calendarEvents":[],"diaryEntries":[],"projects":[],"sprints":[],"kanbanColumns":[],"resources":[],"tags":[],"graphEdges":[]})
    }
    fn req(op: &str) -> Value {
        json!({"scope":SCOPE,"operation":op})
    }
    fn write(revision: u64, title: &str, id: &str) -> Value {
        json!({"scope":SCOPE,"operation":"write","revision":revision,"data":data(title),"draftId":id})
    }
    #[test]
    fn restart_conflict_and_recovery() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(operate(dir.path(), req("read")).unwrap(), Value::Null);
        assert_eq!(operate(dir.path(), write(0, "first", "a")).unwrap(), 1);
        assert!(operate(dir.path(), write(0, "losing", "b")).is_err());
        assert_eq!(
            operate(dir.path(), req("read")).unwrap()["data"]["todos"][0]["title"],
            "first"
        );
        assert_eq!(
            operate(dir.path(), req("drafts")).unwrap()[0]["data"]["todos"][0]["title"],
            "losing"
        );
        assert_eq!(operate(dir.path(), write(1, "resolved", "b")).unwrap(), 2);
        assert_eq!(operate(dir.path(), req("drafts")).unwrap(), json!([]));
    }
    #[test]
    fn damaged_commits_and_interrupted_files_are_not_adopted() {
        let dir = tempfile::tempdir().unwrap();
        operate(dir.path(), write(0, "saved", "a")).unwrap();
        fs::write(dir.path().join("pending.tmp"), b"unfinished").unwrap();
        assert_eq!(operate(dir.path(), req("read")).unwrap()["revision"], 1);
        fs::write(
            dir.path().join("state-00000000000000000001.json"),
            b"broken",
        )
        .unwrap();
        assert!(operate(dir.path(), write(1, "replacement", "b"))
            .unwrap_err()
            .contains("damaged"));
    }
    #[test]
    fn wrong_scope_and_partial_snapshots_fail() {
        let dir = tempfile::tempdir().unwrap();
        assert!(operate(dir.path(), json!({"scope":"../account","operation":"read"})).is_err());
        let mut r = write(0, "title", "a");
        r["data"].as_object_mut().unwrap().remove("projects");
        assert!(operate(dir.path(), r).is_err());
        assert_eq!(operate(dir.path(), req("read")).unwrap(), Value::Null);
    }
    #[test]
    fn a_busy_store_and_duplicate_rows_cannot_replace_saved_content() {
        let dir = tempfile::tempdir().unwrap();
        operate(dir.path(), write(0, "saved", "a")).unwrap();
        let lock = options().open(dir.path().join("operation.lock")).unwrap();
        lock.try_lock().unwrap();
        assert!(operate(dir.path(), write(1, "blocked", "b"))
            .unwrap_err()
            .contains("busy"));
        lock.unlock().unwrap();
        let mut r = write(1, "duplicate", "c");
        r["data"]["todos"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"task"}));
        assert!(operate(dir.path(), r).unwrap_err().contains("Duplicate"));
        assert_eq!(
            operate(dir.path(), req("read")).unwrap()["data"]["todos"][0]["title"],
            "saved"
        );
    }
    #[cfg(unix)]
    #[test]
    fn symlink_storage_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        fs::create_dir(&target).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(operate(&link, req("read")).is_err());
        std::os::unix::fs::symlink(dir.path().join("outside"), target.join("operation.lock"))
            .unwrap();
        assert!(operate(&target, req("read")).is_err());
        assert!(!dir.path().join("outside").exists());
    }
}
