use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use super::{ChannelType, ChannelView, ConversationUserSummary, MessageRetentionDuration};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct DirectMessageChannelEvent {
    pub channel_id: String,
    pub other_user: ConversationUserSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<ChannelView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct GroupCreatedEvent {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    #[serde(rename = "type")]
    pub channel_type: ChannelType,
    pub members: Vec<String>,
    pub member_users: Vec<ConversationUserSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_delete_after: Option<MessageRetentionDuration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persist_messages: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct GroupRemovedEvent {
    pub channel_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct GroupMemberRemovedEvent {
    pub channel_id: String,
    pub user_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct GroupMemberAddedEvent {
    pub channel_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<ConversationUserSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct GroupAvatarUpdatedEvent {
    pub channel_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
}
