//! Descriptor-relative repository I/O. Repository content is untrusted;
//! operator-configured ancestors of the root are trusted. Never return a
//! validated path for a caller to reopen with ambient filesystem authority.

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt, OpenOptionsSyncExt};
#[cfg(unix)]
use cap_fs_ext::OpenOptionsMaybeDirExt;
use cap_std::fs::{Dir, OpenOptions};
use std::ffi::{OsStr, OsString};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

fn denied(reason: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, reason)
}

fn reserved(name: &OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_lowercase();
    matches!(
        name.as_str(),
        ".git" | ".lore" | ".mirror-cache" | ".wabi-repo.json" | ".wabi-mirror-fetched-at"
    ) || name.starts_with(".wabi-publish-")
}

fn portable_component(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    if name.contains(':') || name.ends_with(['.', ' ']) {
        return false;
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    !matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

/// Mandatory path policy, independent of user-editable ignore files.
pub fn validate_path(path: &str) -> io::Result<PathBuf> {
    if path.is_empty()
        || path.len() > 1024
        || path.contains('\\')
        || path.chars().any(|c| c.is_control())
    {
        return Err(denied("invalid repository path"));
    }
    let mut normalized = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(name) if portable_component(name) && !reserved(name) => {
                normalized.push(name)
            }
            _ => {
                return Err(denied(
                    "repository path reaches reserved metadata or escapes its root",
                ))
            }
        }
    }
    if normalized.as_os_str().is_empty()
        || normalized.as_os_str().to_string_lossy().starts_with('-')
    {
        return Err(denied("repository path must name a file, not a CLI option"));
    }
    Ok(normalized)
}

#[derive(Clone, Copy)]
pub(crate) enum InternalFile {
    RepoState,
    WabiIgnore,
    LoreIgnore,
    MirrorFetched,
}

impl InternalFile {
    fn name(self) -> &'static str {
        match self {
            Self::RepoState => ".wabi-repo.json",
            Self::WabiIgnore => ".wabiignore",
            Self::LoreIgnore => ".loreignore",
            Self::MirrorFetched => ".wabi-mirror-fetched-at",
        }
    }
}

pub(crate) struct RepoDir {
    dir: Dir,
}

impl RepoDir {
    pub(crate) fn open(root: &Path) -> io::Result<Self> {
        if root == Path::new(".") || root == Path::new("/") {
            return Ok(Self { dir: Dir::open_ambient_dir(root, cap_std::ambient_authority())? });
        }
        let name = root
            .file_name()
            .ok_or_else(|| denied("repository root must have a name"))?;
        let parent = root
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let parent = Dir::open_ambient_dir(parent, cap_std::ambient_authority())?;
        Ok(Self {
            dir: parent.open_dir_nofollow(name)?,
        })
    }

    /// Create only beneath an already trusted root, refusing every symlink.
    pub(crate) fn child(&self, name: &OsStr, create: bool) -> io::Result<Self> {
        if Path::new(name).components().count() != 1
            || !matches!(
                Path::new(name).components().next(),
                Some(Component::Normal(_))
            )
        {
            return Err(denied("invalid directory component"));
        }
        if create {
            match self.dir.create_dir(name) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
        Ok(Self {
            dir: self.dir.open_dir_nofollow(name)?,
        })
    }

    fn parent(&self, path: &str, create: bool) -> io::Result<(Self, OsString)> {
        let path = validate_path(path)?;
        let mut components = path.components().peekable();
        let mut parent = Self {
            dir: self.dir.try_clone()?,
        };
        while let Some(Component::Normal(name)) = components.next() {
            if components.peek().is_none() {
                return Ok((parent, name.to_os_string()));
            }
            parent = parent.child(name, create)?;
        }
        Err(denied("repository path must name a file"))
    }

    fn open_leaf(&self, name: &OsStr) -> io::Result<std::fs::File> {
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No).nonblock(true);
        let file = self.dir.open_with(name, &options)?;
        if !file.metadata()?.is_file() {
            return Err(denied("repository content must be a regular file"));
        }
        Ok(file.into_std())
    }

    pub(crate) fn open_file(&self, path: &str) -> io::Result<std::fs::File> {
        let (parent, name) = self.parent(path, false)?;
        parent.open_leaf(&name)
    }

    pub(crate) fn read(&self, path: &str) -> io::Result<Vec<u8>> {
        let mut file = self.open_file(path)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    pub(crate) fn read_internal(&self, file: InternalFile) -> io::Result<Vec<u8>> {
        let mut file = self.open_internal(file)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    pub(crate) fn open_internal(&self, file: InternalFile) -> io::Result<std::fs::File> {
        self.open_leaf(OsStr::new(file.name()))
    }

    fn publish(&self, name: &OsStr, mut source: impl Read) -> io::Result<()> {
        // Validate before any truncation. Publication creates a new inode,
        // so replacing a hard link cannot overwrite its other name either.
        match self.open_leaf(name) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let temporary = format!(".wabi-publish-{}", uuid::Uuid::new_v4());
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        #[cfg(unix)]
        {
            use cap_fs_ext::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = self.dir.open_with(&temporary, &options)?;
        let result = (|| {
            io::copy(&mut source, &mut file)?;
            file.flush()?;
            file.sync_all()?;
            drop(file);
            self.dir.rename(&temporary, &self.dir, name)?;
            #[cfg(unix)]
            {
                // Dir may use O_PATH on Linux. Reopen the same held directory
                // with read access before fsync; an O_PATH handle yields EBADF.
                let mut options = OpenOptions::new();
                options.read(true).maybe_dir(true).follow(FollowSymlinks::No);
                self.dir.open_with(".", &options)?.sync_all()?;
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = self.dir.remove_file(&temporary);
        }
        result
    }

    pub(crate) fn write_from(&self, path: &str, source: impl Read) -> io::Result<()> {
        let (parent, name) = self.parent(path, true)?;
        parent.publish(&name, source)
    }

    pub(crate) fn publish_internal(&self, file: InternalFile, bytes: &[u8]) -> io::Result<()> {
        self.publish(OsStr::new(file.name()), bytes)
    }

    pub(crate) fn seed_internal(&self, file: InternalFile, bytes: &[u8]) -> io::Result<()> {
        match self.open_internal(file) {
            Ok(_) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.publish_internal(file, bytes)
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) fn remove_file(&self, path: &str) -> io::Result<()> {
        let (parent, name) = self.parent(path, false)?;
        parent.open_leaf(&name)?;
        parent.dir.remove_file(&name)
    }

    pub(crate) fn remove_child_tree(&self, name: &OsStr) -> io::Result<()> {
        // Refuse a linked root before recursive removal; the capability
        // implementation also confines descendant removal to this directory.
        self.child(name, false)?;
        self.dir.remove_dir_all(name)
    }

    /// Descriptor-relative content inventory. Furniture and non-regular
    /// entries are never exportable, regardless of editable ignore rules.
    pub(crate) fn content_files(&self) -> io::Result<Vec<String>> {
        fn walk(root: &RepoDir, prefix: &str, files: &mut Vec<String>) -> io::Result<()> {
            for entry in root.dir.entries()? {
                let entry = entry?;
                let name = entry.file_name();
                let Some(name_str) = name.to_str() else { continue };
                if matches!(name_str, ".wabiignore" | ".loreignore") { continue; }
                let relative = if prefix.is_empty() { name_str.to_owned() }
                    else { format!("{prefix}/{name_str}") };
                if validate_path(&relative).is_err() { continue; }
                let metadata = root.dir.symlink_metadata(&name)?;
                if metadata.is_dir() {
                    root.child(&name, false).and_then(|child| walk(&child, &relative, files))?;
                } else if metadata.is_file() {
                    if files.len() >= 100_000 { return Err(denied("repository export has too many files")); }
                    files.push(relative);
                }
            }
            Ok(())
        }
        let mut files = Vec::new();
        walk(self, "", &mut files)?;
        files.sort();
        Ok(files)
    }

    /// Check a cloned tree before a CLI can consume repository-controlled
    /// furniture. Git's own top-level .git directory is the sole exception.
    pub(crate) fn validate_import(&self) -> io::Result<()> {
        self.validate_tree(true, true)
    }

    pub(crate) fn validate_cli_tree(&self) -> io::Result<()> {
        self.validate_tree(false, true)
    }

    fn validate_tree(&self, importing: bool, root: bool) -> io::Result<()> {
        for entry in self.dir.entries()? {
            let entry = entry?;
            let name = entry.file_name();
            let metadata = self.dir.symlink_metadata(&name)?;
            if metadata.file_type().is_symlink() {
                return Err(denied("repository symlinks are not supported"));
            }
            if importing && reserved(&name) {
                if root && name == OsStr::new(".git") && metadata.is_dir() {
                    // git clone created this, and import removes it before Lore.
                    continue;
                }
                return Err(denied("import contains reserved repository metadata"));
            }
            if metadata.is_dir() {
                self.child(&name, false)?.validate_tree(importing, false)?;
            } else if !metadata.is_file() {
                return Err(denied("repository contains a non-regular file"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_content_and_atomic_internal_publication() {
        let tree = tempfile::tempdir().unwrap();
        let repo = RepoDir::open(tree.path()).unwrap();
        repo.write_from("src/deep/file.txt", &b"original"[..])
            .unwrap();
        let mut old = repo.open_file("src/deep/file.txt").unwrap();
        repo.write_from("src/deep/file.txt", &b"replacement"[..])
            .unwrap();
        let mut previous = String::new();
        old.read_to_string(&mut previous).unwrap();
        assert_eq!(previous, "original");
        assert_eq!(repo.read("./src/deep/file.txt").unwrap(), b"replacement");
        repo.publish_internal(InternalFile::RepoState, b"first")
            .unwrap();
        let mut old = repo.open_internal(InternalFile::RepoState).unwrap();
        repo.publish_internal(InternalFile::RepoState, b"second")
            .unwrap();
        let mut previous = String::new();
        old.read_to_string(&mut previous).unwrap();
        assert_eq!(previous, "first");
        assert_eq!(
            repo.read_internal(InternalFile::RepoState).unwrap(),
            b"second"
        );
        assert!(!std::fs::read_dir(tree.path()).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".wabi-publish-")));
    }

    #[test]
    fn metadata_is_denied_independently_of_ignore_rules() {
        for path in [
            ".git/config",
            ".lore/head",
            ".wabi-repo.json",
            "./.lore/head",
            "src/.git/config",
            "src/.WABI-REPO.JSON",
            ".mirror-cache/a",
            ".wabi-mirror-fetched-at",
            "../outside",
            "C:\\outside",
            "/outside",
            ".",
            "-flag",
        ] {
            assert!(validate_path(path).is_err(), "accepted {path}");
        }
        assert_eq!(
            validate_path("./normal/file.txt").unwrap(),
            Path::new("normal/file.txt")
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_leaves_directories_and_internal_sidecars_do_not_escape() {
        use std::os::unix::fs::symlink;
        let tree = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("victim"), b"canary").unwrap();
        symlink(outside.path().join("victim"), tree.path().join("leaf")).unwrap();
        symlink(outside.path(), tree.path().join("directory")).unwrap();
        symlink(
            outside.path().join("victim"),
            tree.path().join(".wabi-repo.json"),
        )
        .unwrap();
        let repo = RepoDir::open(tree.path()).unwrap();
        for path in ["leaf", "directory/victim"] {
            assert!(repo.open_file(path).is_err());
            assert!(repo.write_from(path, &b"attack"[..]).is_err());
            assert!(repo.remove_file(path).is_err());
        }
        assert!(repo
            .publish_internal(InternalFile::RepoState, b"attack")
            .is_err());
        assert!(repo.read_internal(InternalFile::RepoState).is_err());
        assert_eq!(
            std::fs::read(outside.path().join("victim")).unwrap(),
            b"canary"
        );
        assert!(repo.validate_import().is_err());
        assert!(repo.validate_cli_tree().is_err());
    }

    #[test]
    fn directories_are_rejected_before_write_and_import_metadata_before_cli() {
        let tree = tempfile::tempdir().unwrap();
        std::fs::create_dir(tree.path().join("directory")).unwrap();
        std::fs::create_dir(tree.path().join(".lore")).unwrap();
        let repo = RepoDir::open(tree.path()).unwrap();
        assert!(repo.write_from("directory", &b"attack"[..]).is_err());
        assert!(repo.validate_import().is_err());
        assert!(tree.path().join("directory").is_dir());
    }

    #[test]
    fn interrupted_publication_preserves_old_content_and_cleans_temporary_file() {
        struct Interrupted;
        impl Read for Interrupted {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::Other, "interrupted source"))
            }
        }
        let tree = tempfile::tempdir().unwrap();
        let repo = RepoDir::open(tree.path()).unwrap();
        repo.publish_internal(InternalFile::RepoState, b"original")
            .unwrap();
        assert!(repo
            .publish(OsStr::new(".wabi-repo.json"), Interrupted)
            .is_err());
        assert_eq!(
            repo.read_internal(InternalFile::RepoState).unwrap(),
            b"original"
        );
        assert_eq!(std::fs::read_dir(tree.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn replacing_checked_directory_with_link_does_not_redirect_held_parent() {
        use std::os::unix::fs::symlink;
        let tree = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("victim"), b"outside").unwrap();
        let repo = RepoDir::open(tree.path()).unwrap();
        repo.write_from("src/victim", &b"inside"[..]).unwrap();
        let (held_parent, name) = repo.parent("src/victim", false).unwrap();
        std::fs::rename(tree.path().join("src"), tree.path().join("parked")).unwrap();
        symlink(outside.path(), tree.path().join("src")).unwrap();
        held_parent.publish(&name, &b"replacement"[..]).unwrap();
        assert_eq!(
            std::fs::read(tree.path().join("parked/victim")).unwrap(),
            b"replacement"
        );
        assert_eq!(
            std::fs::read(outside.path().join("victim")).unwrap(),
            b"outside"
        );
        assert!(repo.open_file("src/victim").is_err());
        assert!(repo.write_from("src/victim", &b"attack"[..]).is_err());
    }
}
