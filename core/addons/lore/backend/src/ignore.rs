//! `.wabiignore` filtering for Lore repos.
//!
//! Since Lore 0.8.6 has no ignore support (EpicGames/lore#118 is open),
//! we filter at the Wabi layer using the `ignore` crate (ripgrep's) for
//! correct gitignore semantics — negation, directory-only patterns,
//! root-anchored vs anywhere, last-match-wins.
//!
//! This is accident prevention, not a security boundary. Direct `lore` CLI
//! bypasses it; that's acceptable (members are trusted).

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use ignore::gitignore::{Gitignore, GitignoreBuilder};

/// Thread-safe lazy-loaded filter for a repo.
///
/// Loads `.wabiignore` from the working tree root on first use,
/// caches the built matcher, and re-checks mtime on subsequent
/// calls to pick up edits.
#[derive(Debug, Clone)]
pub struct LazyRepoFilter {
    working_tree: PathBuf,
    cache: Arc<RwLock<Option<(Gitignore, u64)>>>,
}

impl LazyRepoFilter {
    pub fn new(working_tree: PathBuf) -> Self {
        Self {
            working_tree,
            cache: Arc::new(RwLock::new(None)),
        }
    }

    /// Check if a relative path is ignored.
    pub fn is_ignored(&self, rel_path: &str) -> bool {
        let (matcher, _) = self.load();
        matches!(
            matcher.matched_path_or_any_parents(Path::new(rel_path), false),
            ignore::Match::Ignore(_)
        )
    }

    /// Filter a list of paths, returning only allowed ones.
    pub fn allowed<'a>(&self, paths: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
        let (matcher, _) = self.load();
        paths
            .into_iter()
            .filter(|p| {
                !matches!(
                    matcher.matched_path_or_any_parents(Path::new(*p), false),
                    ignore::Match::Ignore(_)
                )
            })
            .collect()
    }

    /// Load or rebuild the matcher, checking mtime for staleness.
    fn load(&self) -> (Gitignore, u64) {
        {
            let cache = self.cache.read().unwrap();
            if let Some((ref matcher, cached_mtime)) = *cache {
                let wabiignore = self.working_tree.join(".wabiignore");
                if let Ok(metadata) = std::fs::metadata(&wabiignore) {
                    if let Ok(modified) = metadata.modified() {
                        if let Ok(duration) =
                            modified.duration_since(std::time::SystemTime::UNIX_EPOCH)
                        {
                            let current_mtime = duration.as_secs();
                            if current_mtime != cached_mtime {
                                // File changed — drop read lock and rebuild
                                drop(cache);
                                return self.rebuild();
                            }
                        }
                    }
                }
                // Cache is still valid — clone the matcher
                // (Gitignore is cheap to clone for our scale)
                return (matcher.clone(), cached_mtime);
            }
        }
        self.rebuild()
    }

    fn rebuild(&self) -> (Gitignore, u64) {
        let wabiignore = self.working_tree.join(".wabiignore");
        let (matcher, mtime) = if wabiignore.exists() {
            Self::build_from_file(&wabiignore)
        } else {
            Self::build_from_defaults()
        };
        let mut cache = self.cache.write().unwrap();
        *cache = Some((matcher.clone(), mtime));
        (matcher, mtime)
    }

    fn build_from_file(path: &Path) -> (Gitignore, u64) {
        let mut builder = GitignoreBuilder::new(path.parent().unwrap_or_else(|| Path::new("")));
        if let Ok(contents) = std::fs::read_to_string(path) {
            for line in contents.lines() {
                let trimmed = line.trim();
                if !trimmed.is_empty() && !trimmed.starts_with('#') {
                    builder.add_line(None, trimmed).ok();
                }
            }
        }
        let mtime = std::fs::metadata(path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| {
                t.duration_since(std::time::SystemTime::UNIX_EPOCH)
                    .ok()
                    .map(|d| d.as_secs())
            })
            .unwrap_or(0);
        let matcher = builder.build().unwrap_or_else(|_| {
            // Fallback: empty matcher (ignores nothing)
            GitignoreBuilder::new(Path::new(""))
                .build()
                .expect("empty builder should build")
        });
        (matcher, mtime)
    }

    fn build_from_defaults() -> (Gitignore, u64) {
        let mut builder = GitignoreBuilder::new(Path::new(""));
        for pattern in Self::default_patterns() {
            builder.add_line(None, pattern).ok();
        }
        let matcher = builder.build().unwrap_or_else(|_| {
            GitignoreBuilder::new(Path::new(""))
                .build()
                .expect("empty builder should build")
        });
        (matcher, 0)
    }

    /// Default ignore patterns — applied when no `.wabiignore` exists.
    pub fn default_patterns() -> Vec<&'static str> {
        vec![
            "node_modules/",
            "target/",
            "build/",
            "dist/",
            ".env",
            "*.key",
            "*.pem",
            ".DS_Store",
            ".lore/",
            "Intermediate/",
            "Saved/",
            "DerivedDataCache/",
            "Binaries/",
        ]
    }

    /// Generate the default ignore file content.
    pub fn default_ignore_content() -> String {
        Self::default_patterns().join("\n") + "\n"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn defaults_when_no_wabiignore() {
        let dir = TempDir::new().unwrap();
        let filter = LazyRepoFilter::new(dir.path().to_path_buf());
        assert!(filter.is_ignored("node_modules/index.js"));
        assert!(filter.is_ignored("target/debug/main"));
        assert!(filter.is_ignored(".env"));
        assert!(!filter.is_ignored("src/main.rs"));
        assert!(!filter.is_ignored("Cargo.toml"));
    }

    #[test]
    fn loads_custom_wabiignore() {
        let dir = TempDir::new().unwrap();
        let ignore_file = dir.path().join(".wabiignore");
        fs::write(&ignore_file, "*.log\n!important.log\nbuild/\n").unwrap();
        let filter = LazyRepoFilter::new(dir.path().to_path_buf());
        assert!(filter.is_ignored("app.log"));
        assert!(!filter.is_ignored("important.log"));
        assert!(filter.is_ignored("build/output.js"));
        assert!(!filter.is_ignored("src/main.rs"));
    }

    #[test]
    fn directory_only_patterns() {
        let dir = TempDir::new().unwrap();
        let filter = LazyRepoFilter::new(dir.path().to_path_buf());
        assert!(filter.is_ignored("node_modules/foo"));
        assert!(filter.is_ignored("target/foo"));
    }

    #[test]
    fn allowed_filters_list() {
        let dir = TempDir::new().unwrap();
        let filter = LazyRepoFilter::new(dir.path().to_path_buf());
        let paths = vec!["src/main.rs", "node_modules/index.js", "Cargo.toml", ".env"];
        let allowed = filter.allowed(paths);
        assert_eq!(allowed, vec!["src/main.rs", "Cargo.toml"]);
    }

    #[test]
    fn lazy_filter_caches() {
        let dir = TempDir::new().unwrap();
        let lazy = LazyRepoFilter::new(dir.path().to_path_buf());
        assert!(lazy.is_ignored("node_modules/foo"));
        assert!(!lazy.is_ignored("src/main.rs"));
    }

    #[test]
    fn default_patterns_include_common_footguns() {
        let patterns = LazyRepoFilter::default_patterns();
        assert!(patterns.contains(&"node_modules/"));
        assert!(patterns.contains(&"target/"));
        assert!(patterns.contains(&".env"));
        assert!(patterns.contains(&"*.key"));
    }
}
