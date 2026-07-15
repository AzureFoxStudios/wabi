//! Path safety helpers for filesystem joins.
//!
//! WABI_AUDIT_REPORT.md finding #10 — path traversal hardening.
//!
//! The raw `Path::join` API doesn't defend against malicious user input.
//! `safe_join` is the wrapper every HTTP handler / socketio event should
//! use when constructing an upload path from user-supplied strings.

use std::path::{Component, Path, PathBuf};

/// Safely join a base directory with a user-supplied relative path.
///
/// Rejects:
/// - Absolute paths (e.g. "/etc/passwd", "C:\\Windows\\...").
/// - Path components that escape the base ("..", leading "../").
/// - Null bytes (POSIX path injection).
///
/// After joining, the result is canonicalized and verified to be
/// inside `base`. Returns an error if any check fails or if the
/// canonicalized path escapes the canonicalized base (defense against
/// symlink races).
pub fn safe_join(base: &Path, user_input: &str) -> Result<PathBuf, PathError> {
    // Reject null bytes upfront — they're never valid in paths and
    // some C-string APIs truncate at the first NUL.
    if user_input.contains('\0') {
        return Err(PathError::NullByte);
    }

    let candidate = Path::new(user_input);

    // Reject absolute paths. `Component::RootDir` covers "/" on Unix;
    // `Component::Prefix` covers "C:\\" on Windows.
    if candidate.components().any(|c| matches!(c, Component::Prefix(_) | Component::RootDir)) {
        return Err(PathError::Absolute);
    }

    // Reject any ".." in the input — both as a parent traversal
    // and as the literal string. Path::components() also catches
    // "/.." and "./../" patterns.
    if candidate.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(PathError::ParentDir);
    }

    let joined = base.join(candidate);

    // Canonicalize both, verify the result is inside the base. This
    // catches symlink races and residual escape attempts.
    let canon_base = base.canonicalize().map_err(PathError::Canonicalize)?;
    let canon_joined = joined.canonicalize().map_err(PathError::Canonicalize)?;

    if !canon_joined.starts_with(&canon_base) {
        return Err(PathError::EscapesBase);
    }

    Ok(canon_joined)
}

#[derive(Debug, thiserror::Error)]
pub enum PathError {
    #[error("path contains a null byte")]
    NullByte,
    #[error("path is absolute")]
    Absolute,
    #[error("path contains '..'")]
    ParentDir,
    #[error("path escapes its base directory")]
    EscapesBase,
    #[error("canonicalize failed: {0}")]
    Canonicalize(std::io::Error),
}

#[cfg(test)]
mod tests {
    //! WABI_AUDIT_REPORT.md #10 — verify all common path-traversal
    //! payloads are rejected.

    use super::*;
    use std::fs;

    fn make_base() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn make_legit_file(base: &Path) -> PathBuf {
        let p = base.join("legit.txt");
        fs::write(&p, b"hello").unwrap();
        p
    }

    #[test]
    fn rejects_double_dot() {
        let base = make_base();
        assert!(matches!(safe_join(base.path(), ".."), Err(PathError::ParentDir)));
    }

    #[test]
    fn rejects_double_dot_in_subpath() {
        let base = make_base();
        assert!(matches!(safe_join(base.path(), "foo/../bar"), Err(PathError::ParentDir)));
    }

    #[test]
    fn rejects_absolute_unix() {
        let base = make_base();
        assert!(matches!(safe_join(base.path(), "/etc/passwd"), Err(PathError::Absolute)));
    }

    #[test]
    fn rejects_null_byte() {
        let base = make_base();
        assert!(matches!(safe_join(base.path(), "foo\0bar"), Err(PathError::NullByte)));
    }

    #[test]
    fn rejects_escape_via_relative() {
        let base = make_base();
        assert!(matches!(safe_join(base.path(), "../etc/passwd"), Err(PathError::ParentDir)));
    }

    #[test]
    fn allows_legit_relative_path() {
        let base = make_base();
        make_legit_file(base.path());
        let result = safe_join(base.path(), "legit.txt").unwrap();
        assert!(result.ends_with("legit.txt"));
    }

    #[test]
    fn allows_legit_subpath() {
        let base = make_base();
        let sub = base.path().join("sub");
        fs::create_dir_all(&sub).unwrap();
        let p = sub.join("nested.txt");
        fs::write(&p, b"x").unwrap();
        let result = safe_join(base.path(), "sub/nested.txt").unwrap();
        assert!(result.ends_with("nested.txt"));
    }
}
