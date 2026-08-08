//! Lore workspace capability vocabulary.
//!
//! Fine-grained capabilities for Lore workspace operations. These are NOT the same
//! as `UserRole` — a single role can map to many capabilities.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

/// Fine-grained capabilities for Lore workspace operations.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum LoreCapability {
    /// Push to any branch
    RefPush,
    /// Merge branches (into protected refs)
    RefMerge,
    /// Force push to a branch
    RefForcePush,
    /// Delete a branch
    RefDelete,
    /// Write to any path in the repo
    PathWriteAll,
    /// Write to a specific path pattern (stored as string, checked at runtime)
    PathWritePattern,
    /// Create/modify file locks
    Lock,
    /// Approve review changes
    ReviewApprove,
    /// Edit policy rules
    PolicyEdit,
    /// Pause workspace egress (incident response)
    EgressPause,
    /// View audit log
    AuditView,
}

impl LoreCapability {
    /// All capabilities as a slice.
    pub const fn all() -> &'static [Self] {
        &[
            Self::RefPush,
            Self::RefMerge,
            Self::RefForcePush,
            Self::RefDelete,
            Self::PathWriteAll,
            Self::PathWritePattern,
            Self::Lock,
            Self::ReviewApprove,
            Self::PolicyEdit,
            Self::EgressPause,
            Self::AuditView,
        ]
    }
}

/// Set of Lore capabilities with common set operations.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub struct LoreCapabilitySet {
    #[cfg_attr(feature = "ts", ts(as = "Vec<LoreCapability>"))]
    inner: HashSet<LoreCapability>,
}

impl LoreCapabilitySet {
    pub fn new() -> Self {
        Self {
            inner: HashSet::new(),
        }
    }

    pub fn all() -> Self {
        Self {
            inner: LoreCapability::all().iter().copied().collect(),
        }
    }

    pub fn from_caps(caps: impl IntoIterator<Item = LoreCapability>) -> Self {
        Self {
            inner: caps.into_iter().collect(),
        }
    }

    pub fn contains(&self, cap: LoreCapability) -> bool {
        self.inner.contains(&cap)
    }

    pub fn insert(&mut self, cap: LoreCapability) {
        self.inner.insert(cap);
    }

    pub fn remove(&mut self, cap: LoreCapability) {
        self.inner.remove(&cap);
    }

    pub fn union(&self, other: &Self) -> Self {
        Self {
            inner: self.inner.union(&other.inner).copied().collect(),
        }
    }

    pub fn intersection(&self, other: &Self) -> Self {
        Self {
            inner: self.inner.intersection(&other.inner).copied().collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    pub fn len(&self) -> usize {
        self.inner.len()
    }

    pub fn iter(&self) -> impl Iterator<Item = LoreCapability> + '_ {
        self.inner.iter().copied()
    }
}

impl FromIterator<LoreCapability> for LoreCapabilitySet {
    fn from_iter<T: IntoIterator<Item = LoreCapability>>(iter: T) -> Self {
        Self {
            inner: iter.into_iter().collect(),
        }
    }
}

impl<'a> IntoIterator for &'a LoreCapabilitySet {
    type Item = LoreCapability;
    type IntoIter = std::iter::Copied<std::collections::hash_set::Iter<'a, LoreCapability>>;

    fn into_iter(self) -> Self::IntoIter {
        self.inner.iter().copied()
    }
}