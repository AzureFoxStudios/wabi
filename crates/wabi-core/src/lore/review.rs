//! Lightweight review types for the code review flow.
//!
//! One object, not a GitHub LARP. Propose change → diff → discuss → approve → merge.

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

/// Review status progression.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, )]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub enum ReviewStatus {
    Open,
    Approved,
    ChangesRequested,
    Merged,
    Closed,
}

/// A lightweight code review.
#[derive(Debug, Clone, Serialize, Deserialize, )]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub struct CodeReview {
    pub id: String,
    pub channel_id: String,
    pub title: String,
    pub description: Option<String>,
    pub source_branch: String,
    pub target_branch: String,
    pub status: ReviewStatus,
    pub author_id: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub merged_at: Option<u64>,
    pub merged_by: Option<String>,
    pub commit_count: u32,
    pub file_change_count: u32,
    pub insertions: u32,
    pub deletions: u32,
}

/// Inline comment on a specific diff line.
#[derive(Debug, Clone, Serialize, Deserialize, )]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub struct ReviewComment {
    pub id: String,
    pub review_id: String,
    pub file_path: String,
    pub line_number: u32,
    pub side: DiffSide,
    pub author_id: String,
    pub content: String,
    pub parent_id: Option<String>,
    pub created_at: u64,
    pub resolved: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, )]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub enum DiffSide {
    Left,
    Right,
}

/// Review action result.
#[derive(Debug, Clone, Serialize, Deserialize, )]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub struct ReviewAction {
    pub review_id: String,
    pub action: ReviewActionType,
    pub actor_id: String,
    pub comment: Option<String>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, )]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub enum ReviewActionType {
    Approve,
    RequestChanges,
    Merge,
    Close,
}

/// Draft save: in-browser edits stored as a draft branch.
#[derive(Debug, Clone, Serialize, Deserialize, )]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub struct DraftSave {
    pub id: String,
    pub channel_id: String,
    pub file_path: String,
    pub content: String,
    pub author_id: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub draft_branch: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_review_creation() {
        let review = CodeReview {
            id: "review-1".to_string(),
            channel_id: "ch_1".to_string(),
            title: "Fix login bug".to_string(),
            description: Some("Fixes the login bounce issue".to_string()),
            source_branch: "fix-login".to_string(),
            target_branch: "main".to_string(),
            status: ReviewStatus::Open,
            author_id: "user-1".to_string(),
            created_at: 1000,
            updated_at: 1000,
            merged_at: None,
            merged_by: None,
            commit_count: 1,
            file_change_count: 2,
            insertions: 15,
            deletions: 3,
        };
        assert_eq!(review.status, ReviewStatus::Open);
    }

    #[test]
    fn test_review_comment() {
        let comment = ReviewComment {
            id: "comment-1".to_string(),
            review_id: "review-1".to_string(),
            file_path: "src/main.rs".to_string(),
            line_number: 42,
            side: DiffSide::Right,
            author_id: "user-2".to_string(),
            content: "Consider using `let` here".to_string(),
            parent_id: None,
            created_at: 1001,
            resolved: false,
        };
        assert!(!comment.resolved);
    }
}