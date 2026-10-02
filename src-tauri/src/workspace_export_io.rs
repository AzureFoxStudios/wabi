//! The desktop export writer. No network, application database or caller paths.
//! A destination comes only from a native save dialog in workspace_export.rs.
//! Tests compile with rustc alone on Linux, Windows and macOS.
use std::{fs::{self, File, Metadata, OpenOptions}, io::{self, Write}, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}, time::{SystemTime, UNIX_EPOCH}};

pub const MAX_EXPORT_BYTES: usize = 32 * 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(1);

fn unique() -> String {
    format!("{}-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos(), NEXT.fetch_add(1, Ordering::Relaxed))
}
fn invalid(message: &'static str) -> io::Error { io::Error::new(io::ErrorKind::InvalidInput, message) }

/// Suggestions are basenames, never paths, Windows ADS names or device names.
pub fn safe_name(input: &str) -> String {
    let cleaned: String = input.chars().map(|c| if c.is_control() || matches!(c, '/'|'\\'|':'|'<'|'>'|'"'|'|'|'?'|'*'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}') { '_' } else { c }).collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    let mut name = if cleaned.is_empty() { "Wabi-export.bin".to_owned() } else { cleaned.to_owned() };
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if ["CON","PRN","AUX","NUL","CONIN$","CONOUT$"].contains(&stem.as_str()) || stem.strip_prefix("COM").or_else(||stem.strip_prefix("LPT")).is_some_and(|v| matches!(v, "1"|"2"|"3"|"4"|"5"|"6"|"7"|"8"|"9"|"¹"|"²"|"³")) {
        name.insert(0, '_');
    }
    // Preserve a useful extension when shortening long Unicode suggestions.
    if name.len() > 180 {
        let extension = name.rsplit_once('.').map(|(_, ext)| ext).filter(|ext| ext.len() <= 12 && ext.chars().all(|c|c.is_ascii_alphanumeric())).unwrap_or("bin").to_owned();
        let mut end = 160.min(name.len()); while !name.is_char_boundary(end) { end -= 1; }
        name = format!("{}.{}", &name[..end], extension);
    }
    name
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TargetState {
    length: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)] device: u64,
    #[cfg(unix)] inode: u64,
}
fn identity(meta: &Metadata) -> TargetState {
    #[cfg(unix)] use std::os::unix::fs::MetadataExt;
    TargetState { length: meta.len(), modified: meta.modified().ok(), #[cfg(unix)] device: meta.dev(), #[cfg(unix)] inode: meta.ino() }
}
pub fn inspect_target(path: &Path) -> io::Result<Option<TargetState>> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_file() { return Err(invalid("Choose a regular file, not a directory or symbolic link.")); }
            if meta.permissions().readonly() { return Err(io::Error::new(io::ErrorKind::PermissionDenied, "The selected file is read-only.")); }
            Ok(Some(identity(&meta)))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Resolve the chosen parent once. Never create caller-selected directories.
pub fn destination(selected: &Path) -> io::Result<PathBuf> {
    if !selected.is_absolute() { return Err(invalid("The save dialog did not return an absolute path.")); }
    let name = selected.file_name().ok_or_else(||invalid("Choose a file name."))?;
    let text = name.to_str().ok_or_else(||invalid("Use a Unicode file name."))?;
    if text.is_empty() || text.contains([':', '\\', '/', '\0']) || text == "." || text == ".." { return Err(invalid("Unsupported destination file name.")); }
    let parent = selected.parent().ok_or_else(||invalid("Choose a destination directory."))?.canonicalize()?;
    if !parent.is_dir() { return Err(invalid("The destination directory is unavailable.")); }
    Ok(parent.join(name))
}
struct Staged { path: PathBuf, file: Option<File> }
impl Drop for Staged {
    fn drop(&mut self) { self.file.take(); let _ = fs::remove_file(&self.path); }
}
fn stage(parent: &Path) -> io::Result<Staged> {
    for _ in 0..8 {
        let path = parent.join(format!(".wabi-export-{}.part", unique()));
        let mut options = OpenOptions::new(); options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        match options.open(&path) {
            Ok(file) => return Ok(Staged { path, file: Some(file) }),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "Could not reserve a temporary export file."))
}

#[derive(Debug)]
pub struct Receipt { pub bytes_written: usize, pub directory_synced: bool }

/// Stage + fsync before changing the selected name. Ordinary errors never
/// truncate an existing destination. A new name uses atomic no-clobber linking;
/// filesystems without hard-link support fail visibly rather than overwrite.
/// Concurrent hostile mutation of an ancestor directory is outside this API's
/// threat model; this is not a general sandbox for other local processes.
pub fn write_export(target: &Path, expected: &Option<TargetState>, bytes: &[u8]) -> io::Result<Receipt> {
    if bytes.len() > MAX_EXPORT_BYTES { return Err(invalid("Native exports are limited to 32 MiB.")); }
    write_with(target, expected, bytes.len(), |file| file.write_all(bytes), || Ok(()))
}
fn write_with(target: &Path, expected: &Option<TargetState>, length: usize, write: impl FnOnce(&mut File)->io::Result<()>, before_commit: impl FnOnce()->io::Result<()>) -> io::Result<Receipt> {
    let parent = target.parent().ok_or_else(||invalid("Missing export parent."))?;
    if &inspect_target(target)? != expected { return Err(io::Error::new(io::ErrorKind::AlreadyExists, "Destination changed. Choose it again before replacing it.")); }
    let mut staged = stage(parent)?;
    let file = staged.file.as_mut().expect("new staged file");
    write(file)?;
    if file.metadata()?.len() != length as u64 { return Err(io::Error::new(io::ErrorKind::WriteZero, "Incomplete export write.")); }
    file.sync_all()?;
    staged.file.take(); // Close before commit, including on Windows.
    before_commit()?;
    if &inspect_target(target)? != expected { return Err(io::Error::new(io::ErrorKind::AlreadyExists, "Destination changed during export. No replacement was made.")); }
    if expected.is_some() { fs::rename(&staged.path, target)?; }
    else { fs::hard_link(&staged.path, target)?; }
    // A failure flushing the directory happens AFTER commit. Report it as a
    // durability warning, never as an uncommitted save that invites blind retry.
    #[cfg(unix)] let directory_synced = File::open(parent).and_then(|dir|dir.sync_all()).is_ok();
    #[cfg(not(unix))] let directory_synced = false;
    Ok(Receipt { bytes_written: length, directory_synced })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture { fn new()->Self { let path=std::env::temp_dir().join(format!("wabi-export-test-{}",unique()));fs::create_dir(&path).unwrap();Self(path) } fn target(&self)->PathBuf { self.0.join("export.txt") } fn count(&self)->usize { fs::read_dir(&self.0).unwrap().count() } }
    impl Drop for Fixture { fn drop(&mut self){let _=fs::remove_dir_all(&self.0);} }
    #[test] fn workspace_export_suggestions_are_bounded_safe_and_unicode(){
        for name in ["../escape.csv","C:\\Windows\\file.txt","book.xlsx:program","CON.txt","LPT1.csv","COM¹.json",".\n.","normal คน 🙂.xlsx"] { let out=safe_name(name);assert!(!out.contains(['/', '\\', ':']));assert!(!out.chars().any(char::is_control));assert!(!out.is_empty()); }
        assert_eq!(safe_name("normal คน 🙂.xlsx"),"normal คน 🙂.xlsx");assert_eq!(safe_name("CON.txt"),"_CON.txt");assert_eq!(safe_name(".."),"Wabi-export.bin");assert!(safe_name(&format!("{}.xlsx","ก".repeat(300))).len()<=180);
    }
    #[test] fn workspace_export_new_file_is_exact_and_leaves_no_staging_file(){let f=Fixture::new();let bytes=b"\x00\xffOriginal\n";let receipt=write_export(&f.target(),&None,bytes).unwrap();assert_eq!(receipt.bytes_written,bytes.len());assert_eq!(fs::read(f.target()).unwrap(),bytes);assert_eq!(f.count(),1);}
    #[test] fn workspace_export_replaces_only_an_approved_existing_file(){let f=Fixture::new();fs::write(f.target(),b"old").unwrap();assert!(write_export(&f.target(),&None,b"new").is_err());let expected=inspect_target(&f.target()).unwrap();write_export(&f.target(),&expected,b"new longer").unwrap();assert_eq!(fs::read(f.target()).unwrap(),b"new longer");assert_eq!(f.count(),1);}
    #[test] fn workspace_export_write_failure_preserves_original_and_cleans_temp(){let f=Fixture::new();fs::write(f.target(),b"retained").unwrap();let expected=inspect_target(&f.target()).unwrap();let result=write_with(&f.target(),&expected,100,|file|{file.write_all(b"partial")?;Err(io::Error::new(io::ErrorKind::Other,"injected failure"))},||Ok(()));assert!(result.is_err());assert_eq!(fs::read(f.target()).unwrap(),b"retained");assert_eq!(f.count(),1);}
    #[test] fn workspace_export_cancel_before_commit_preserves_original(){let f=Fixture::new();fs::write(f.target(),b"retained").unwrap();let expected=inspect_target(&f.target()).unwrap();assert!(write_with(&f.target(),&expected,3,|file|file.write_all(b"new"),||Err(io::Error::new(io::ErrorKind::Interrupted,"cancelled"))).is_err());assert_eq!(fs::read(f.target()).unwrap(),b"retained");assert_eq!(f.count(),1);}
    #[test] fn workspace_export_detects_a_destination_changed_while_writing(){let f=Fixture::new();let target=f.target();assert!(write_with(&target,&None,3,|file|file.write_all(b"new"),||fs::write(&target,b"another application")).is_err());assert_eq!(fs::read(target).unwrap(),b"another application");assert_eq!(f.count(),1);}
    #[test] fn workspace_export_rejects_incomplete_write_and_directory(){let f=Fixture::new();assert!(write_with(&f.target(),&None,5,|file|file.write_all(b"bad"),||Ok(())).is_err());assert_eq!(f.count(),0);assert!(inspect_target(&f.0).is_err());assert!(destination(Path::new("relative.txt")).is_err());}
    #[test] fn workspace_export_oversize_does_not_create_a_file(){let f=Fixture::new();assert!(write_export(&f.target(),&None,&vec![0;MAX_EXPORT_BYTES+1]).is_err());assert_eq!(f.count(),0);}
    #[cfg(unix)] #[test] fn workspace_export_rejects_symlink_and_protects_new_file_mode(){use std::os::unix::fs::{symlink,PermissionsExt};let f=Fixture::new();let source=f.0.join("source");fs::write(&source,b"private").unwrap();symlink(&source,f.target()).unwrap();assert!(write_export(&f.target(),&None,b"wrong").is_err());assert_eq!(fs::read(source).unwrap(),b"private");fs::remove_file(f.target()).unwrap();write_export(&f.target(),&None,b"private export").unwrap();assert_eq!(fs::metadata(f.target()).unwrap().permissions().mode()&0o777,0o600);}
}
