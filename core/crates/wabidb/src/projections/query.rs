//! Typed projection query API (A2).
//!
//! Extends the `Projection` trait with a uniform, filterable `query()` entry
//! point. Each projection declares a `Record` and a `Filter` type and
//! implements the lookup logic. Where a secondary index exists (e.g. messages
//! by channel / by author), `query()` uses the `O(log n)` prefix path rather
//! than a full `for_each` scan over the primary index.
//!
//! The default trait methods operate on the primary index and decode only the
//! rows that match, so implementations that only need filtering by a single
//! typed filter can lean on the helpers here. Projections with secondary
//! indexes override the relevant branches to use `ProjectionState::with_index`.

use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::handler::Projection;

/// A projection that can answer typed, filtered queries against its state.
///
/// Adapts to the existing [`Projection`] trait: any `QueryableProjection` is a
/// `Projection`. `query()` returns zero or more `Record`s satisfying `filter`.
pub trait QueryableProjection: Projection {
    /// The decoded record type returned by `query()`.
    type Record;
    /// The filter used to constrain `query()` results.
    type Filter;

    /// Return all records matching `filter`. Implementations should prefer
    /// secondary-index prefix scans over a full primary-index `for_each` scan
    /// when the filter narrows by an indexed key (channel, author, etc.).
    fn query(&self, state: &ProjectionState, filter: &Self::Filter) -> Result<Vec<Self::Record>>;
}

// ---------------------------------------------------------------------------
// Shared filter types
// ---------------------------------------------------------------------------

/// Filter for the messages projection.
///
/// `channel_id` and `author_id` are served by the `messages_by_channel` and
/// `messages_by_author` secondary indexes (prefix scans). `limit` truncates the
/// result set; `include_deleted` controls whether soft-deleted rows appear.
#[derive(Debug, Clone, Default)]
pub struct MessagesFilter {
    pub channel_id: Option<String>,
    pub author_id: Option<u64>,
    pub since_seq: Option<u64>,
    pub limit: Option<usize>,
    pub include_deleted: bool,
}

/// Filter for the reactions projection (keyed by `message_id`).
#[derive(Debug, Clone, Default)]
pub struct ReactionsFilter {
    pub message_id: Option<String>,
    pub user_id: Option<u64>,
    pub limit: Option<usize>,
}

/// Filter for the DM messages projection (keyed by `dm_id`).
#[derive(Debug, Clone, Default)]
pub struct DmMessagesFilter {
    pub dm_id: Option<String>,
    pub author_id: Option<u64>,
    pub limit: Option<usize>,
}

/// Filter for the users projection.
#[derive(Debug, Clone, Default)]
pub struct UsersFilter {
    pub user_id: Option<u64>,
    pub is_active: Option<bool>,
    pub limit: Option<usize>,
}

/// Filter for the channels projection.
#[derive(Debug, Clone, Default)]
pub struct ChannelsFilter {
    pub channel_id: Option<String>,
    pub limit: Option<usize>,
}

/// Filter for the wiki projection (keyed by `channel_id`).
#[derive(Debug, Clone, Default)]
pub struct WikiFilter {
    pub channel_id: Option<String>,
    pub page_id: Option<String>,
    pub include_deleted: bool,
    pub limit: Option<usize>,
}

/// Filter for the forum projection (keyed by `channel_id`/`thread_id`).
#[derive(Debug, Clone, Default)]
pub struct ForumFilter {
    pub channel_id: Option<String>,
    pub thread_id: Option<String>,
    pub threads_only: bool,
    pub include_deleted: bool,
    pub limit: Option<usize>,
}

/// Filter for the incidents projection (keyed by `channel_id`).
#[derive(Debug, Clone, Default)]
pub struct IncidentsFilter {
    pub channel_id: Option<String>,
    pub incident_id: Option<String>,
    pub include_deleted: bool,
    pub limit: Option<usize>,
}

/// Apply a `limit` to a collected result vector in place.
pub(crate) fn apply_limit<T>(results: &mut Vec<T>, limit: Option<usize>) {
    if let Some(n) = limit {
        results.truncate(n);
    }
}
