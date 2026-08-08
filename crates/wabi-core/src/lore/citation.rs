//! Code citation types for the `^c/` citation system.
//!
//! Extends Wabi's existing object-ref citation engine to support code fragments
//! from Lore repositories. Supports both **pinned** (snapshot at a specific
//! revision) and **tracking** (follows a branch) modes.

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

/// Citation mode: pinned to a revision or tracking a branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub enum CitationMode {
    /// Snapshot at a specific revision — content never changes.
    Pinned,
    /// Follows a branch — content updates as the branch moves.
    Tracking,
}

/// A cited code fragment: file path, line range, and revision reference.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub struct CodeCitation {
    /// Channel/repo key this citation belongs to.
    pub channel_id: String,
    /// File path within the repo.
    pub file_path: String,
    /// Start line (1-indexed).
    pub start_line: u32,
    /// End line (1-indexed, inclusive).
    pub end_line: u32,
    /// Citation mode.
    pub mode: CitationMode,
    /// Branch name (required for Tracking).
    #[serde(default)]
    pub branch: Option<String>,
    /// Revision hash (required for Pinned).
    #[serde(default)]
    pub revision: Option<String>,
    /// Snapshot of the cited content at citation time.
    #[serde(default)]
    pub snapshot: Option<String>,
    /// Content hash for drift detection.
    #[serde(default)]
    pub content_hash: Option<String>,
    /// Label/title shown in the citation chip.
    #[serde(default)]
    pub label: Option<String>,
}

impl CodeCitation {
    /// Parse a `^c/` citation string into a CodeCitation.
    ///
    /// Format: `^c/path/to/file.rs:10-25@branch` (tracking)
    ///         `^c/path/to/file.rs:10-25@rev:a1b2c3` (pinned)
    ///         `^c/path/to/file.rs` (full file, defaults to tracking main)
    pub fn parse(input: &str) -> Option<Self> {
        let input = input.strip_prefix("^c/").unwrap_or(input);

        // Split on last '@' for ref part
        let (path_part, ref_part): (&str, Option<&str>) = match input.rsplit_once('@') {
            Some((path, ref_s)) => (path, Some(ref_s)),
            None => (input, None),
        };

        // Split path on last ':' for line range (but only if no '@' was found or ':' is before '@')
        let (path, lines): (&str, Option<&str>) = match path_part.rsplit_once(':') {
            Some((p, l)) => (p, Some(l)),
            None => (path_part, None),
        };

        let (start_line, end_line) = if let Some(lines_str) = lines {
            let parts: Vec<&str> = lines_str.split('-').collect();
            if parts.len() == 2 {
                (
                    parts[0].parse::<u32>().ok()? + 1,
                    parts[1].parse::<u32>().ok()? + 1,
                )
            } else if parts.len() == 1 {
                let line = parts[0].parse::<u32>().ok()? + 1;
                (line, line)
            } else {
                (1, u32::MAX)
            }
        } else {
            (1, u32::MAX)
        };

        let (mode, branch, revision) = match ref_part {
            Some(ref_str) if ref_str.starts_with("rev:") => {
                (CitationMode::Pinned, None, Some(ref_str[4..].to_string()))
            }
            Some(branch_name) => (CitationMode::Tracking, Some(branch_name.to_string()), None),
            None => (CitationMode::Tracking, Some("main".to_string()), None),
        };

        Some(CodeCitation {
            channel_id: String::new(),
            file_path: path.to_string(),
            start_line,
            end_line,
            mode,
            branch,
            revision,
            snapshot: None,
            content_hash: None,
            label: None,
        })
    }

    /// Format back to `^c/` string.
    pub fn to_string(&self) -> String {
        let range = if self.start_line == 1 && self.end_line == u32::MAX {
            String::new()
        } else if self.start_line == self.end_line {
            format!(":{}", self.start_line)
        } else {
            format!(":{}-{}", self.start_line, self.end_line)
        };

        let ref_suffix = match self.mode {
            CitationMode::Pinned => self.revision.as_deref()
                .map(|r| format!("@rev:{}", r))
                .unwrap_or_default(),
            CitationMode::Tracking => self.branch.as_deref()
                .map(|b| format!("@{}", b))
                .unwrap_or_else(|| "@main".to_string()),
        };

        format!("^c/{}{}{}", self.file_path, range, ref_suffix)
    }

    /// Check if this citation is a full-file citation (no line range).
    pub fn is_full_file(&self) -> bool {
        self.start_line == 1 && self.end_line == u32::MAX
    }
}

/// Drift state for tracking citations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub enum CitationDrift {
    /// Content matches the snapshot — no drift.
    Current,
    /// Content has changed since the citation was created.
    Drifted {
        /// Hash of the current content.
        current_hash: String,
        /// Hash at citation time.
        original_hash: String,
        /// Number of lines added.
        lines_added: u32,
        /// Number of lines removed.
        lines_removed: u32,
    },
    /// The cited path no longer exists.
    Missing,
}

/// A resolved citation with its actual content.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub struct ResolvedCitation {
    pub citation: CodeCitation,
    pub content: String,
    pub language: Option<String>,
    pub drift: CitationDrift,
    pub resolved_at: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_tracking() {
        let cit = CodeCitation::parse("^c/src/main.rs:10-25@develop").unwrap();
        assert_eq!(cit.file_path, "src/main.rs");
        assert_eq!(cit.start_line, 11);
        assert_eq!(cit.end_line, 26);
        assert_eq!(cit.mode, CitationMode::Tracking);
        assert_eq!(cit.branch, Some("develop".to_string()));
    }

    #[test]
    fn test_parse_pinned() {
        let cit = CodeCitation::parse("^c/src/main.rs:10-25@rev:a1b2c3d4").unwrap();
        assert_eq!(cit.mode, CitationMode::Pinned);
        assert_eq!(cit.revision, Some("a1b2c3d4".to_string()));
    }

    #[test]
    fn test_parse_full_file() {
        let cit = CodeCitation::parse("^c/README.md").unwrap();
        assert!(cit.is_full_file());
        assert_eq!(cit.branch, Some("main".to_string()));
    }

    #[test]
    fn test_roundtrip() {
        let cit = CodeCitation::parse("^c/src/lib.rs:5-20@feature-x").unwrap();
        let s = cit.to_string();
        assert!(s.starts_with("^c/src/lib.rs"));
        assert!(s.contains("@feature-x"));
    }
}