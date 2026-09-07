//! Aggregate writes only. Server command admission owns authorization and
//! serialization; these methods never announce success before full application.
use super::*;
use wabidb::{
    domain::ChannelKind,
    projections::channel_members::{ChannelMemberRecord, ChannelMembersChanged},
};

fn invalid(reason: &str) -> WabiError {
    WabiError::Validation {
        command: "group_membership".into(),
        reason: reason.into(),
    }
}

impl WdbAdapter {
    async fn commit_group_events(
        &self,
        actor: u64,
        name: &str,
        events: Vec<EventToWrite>,
    ) -> Result<u64> {
        for event in &events {
            self.engine
                .get_or_create_stream_key(&event.stream_id)
                .await?;
        }
        let deliveries: Vec<_> = events
            .iter()
            .map(|e| {
                (
                    e.stream_id.clone(),
                    e.event_type.clone(),
                    e.plaintext.clone(),
                )
            })
            .collect();
        let outcome = self
            .engine
            .run_command(CommandCommit {
                caller_user_id: actor,
                caller_device_id: "primary".into(),
                command_name: name.into(),
                idempotency_key: None,
                events,
                essential: true,
                response_tx: tokio::sync::oneshot::channel().0,
            })
            .await?;
        // Same applied-before-subscription-push boundary as adapter::run.
        for (stream, kind, payload) in deliveries {
            self.engine
                .deliver_event(&stream, &kind, &payload, outcome.commit_seq)
                .await;
        }
        Ok(outcome.commit_seq)
    }

    fn group_event(stream: String, kind: &str, payload: Vec<u8>) -> EventToWrite {
        EventToWrite {
            stream_id: stream,
            event_type: kind.into(),
            stream_kind: 1,
            record_kind: RecordKind::Event,
            plaintext: payload,
        }
    }

    pub(super) async fn create_group_command(
        &self,
        id: &str,
        name: &str,
        owner: u64,
        members: &[u64],
    ) -> Result<u64> {
        if !id.starts_with("group-")
            || id.len() > 128
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            || name.trim().is_empty()
            || name.len() > 100
            || name.chars().any(char::is_control)
            || members.len() < 2
            || members.len() > 256
            || owner == 0
            || !members.contains(&owner)
        {
            return Err(invalid("invalid group identity, name or members"));
        }
        if self.get_channel(id).await?.is_some()
            || wabidb::projections::channel_members::ChannelMembersProjection::revision(
                &self.engine.projection_state(),
                id,
            )? != 0
        {
            return Err(invalid("group identity already used"));
        }
        let now = now_micros();
        let change = ChannelMembersChanged {
            channel_id: id.into(),
            removals: vec![],
            upserts: members
                .iter()
                .map(|uid| ChannelMemberRecord {
                    channel_id: id.into(),
                    user_id: *uid,
                    joined_at_micros: now,
                    role: 0,
                    nick: None,
                })
                .collect(),
        };
        change.validate()?;
        let mut channel = Channel::new(id, name.trim(), owner);
        channel.channel_kind = ChannelKind::GroupDm;
        channel.created_at_micros = now;
        self.commit_group_events(
            owner,
            "create_group",
            vec![
                Self::group_event(id.into(), "channel_created", Self::payload_json(&channel)?),
                Self::group_event(
                    format!("channel_members:{id}"),
                    "channel_members_changed",
                    Self::payload_json(&change)?,
                ),
            ],
        )
        .await
    }

    pub(super) async fn change_group_membership_command(
        &self,
        actor: u64,
        id: &str,
        add: Option<u64>,
        remove: Option<u64>,
        owner: u64,
    ) -> Result<u64> {
        if add.is_none() && remove.is_none() {
            return Err(invalid("an add or removal is required"));
        }
        let channel = self
            .get_channel(id)
            .await?
            .ok_or_else(|| invalid("group not found"))?;
        if channel.channel_kind != ChannelKind::GroupDm || actor == 0 {
            return Err(invalid("not a group command"));
        }
        let mut members = self.list_channel_members(id).await?;
        if let Some(uid) = remove {
            members.retain(|m| m.user_id != uid);
        }
        if let Some(uid) = add {
            if members.iter().any(|m| m.user_id == uid) {
                return Err(invalid("member already exists"));
            }
            members.push(ChannelMember {
                channel_id: id.into(),
                user_id: uid,
                role: wabidb::domain::MemberRole::Member,
                joined_at_micros: now_micros(),
            });
        }
        if (add.is_some() && members.len() > 256)
            || (members.is_empty() && owner != 0)
            || (!members.is_empty() && !members.iter().any(|m| m.user_id == owner))
        {
            return Err(invalid(
                "group must have a remaining owner and at most 256 members",
            ));
        }
        let change = ChannelMembersChanged {
            channel_id: id.into(),
            removals: remove.into_iter().collect(),
            upserts: add
                .into_iter()
                .map(|uid| ChannelMemberRecord {
                    channel_id: id.into(),
                    user_id: uid,
                    joined_at_micros: now_micros(),
                    role: 0,
                    nick: None,
                })
                .collect(),
        };
        change.validate()?;
        let (event, payload) = if members.is_empty() {
            ("channel_deleted", serde_json::json!({"channel_id": id}))
        } else {
            (
                "channel_updated",
                serde_json::json!({"channel_id": id, "owner_user_id": owner}),
            )
        };
        let mut events = vec![
            Self::group_event(
                format!("channel_members:{id}"),
                "channel_members_changed",
                Self::payload_json(&change)?,
            ),
            Self::group_event(
                format!("channels:{id}"),
                event,
                Self::payload_json(&payload)?,
            ),
        ];
        // Use the existing call-leave/end JSON contracts in this SAME command.
        // Clearing only the live roster would restore stale durable consent on
        // re-add/restart. Server admission holds membership_gate's writer so no
        // REST join can append a fresh participant between this read and commit.
        if let Some(removed) = remove {
            let now = now_micros();
            for session in self.list_channel_call_sessions(id).await? {
                for participant in self.get_call_participants(&session.session_id).await? {
                    if participant.left_at_micros.is_none()
                        && (participant.user_id == removed || members.is_empty())
                    {
                        events.push(EventToWrite {
                            stream_id: format!(
                                "call_participant:{}:{}",
                                session.session_id, participant.user_id
                            ),
                            event_type: "call_participant_left".into(),
                            stream_kind: 6,
                            record_kind: RecordKind::Event,
                            plaintext: Self::payload_json(&serde_json::json!({
                                "session_id": session.session_id, "user_id": participant.user_id,
                                "left_at_micros": now, "last_updated_at_micros": now,
                            }))?,
                        });
                    }
                }
                if members.is_empty() && session.active {
                    events.push(EventToWrite {
                        stream_id: format!("call_session:{}", session.session_id),
                        event_type: "call_session_ended".into(),
                        stream_kind: 6,
                        record_kind: RecordKind::Event,
                        plaintext: Self::payload_json(&serde_json::json!({
                            "session_id": session.session_id, "active": false,
                            "ended_at_micros": now, "last_updated_at_micros": now,
                        }))?,
                    });
                }
            }
        }
        self.commit_group_events(actor, "change_group_membership", events)
            .await
    }
}
