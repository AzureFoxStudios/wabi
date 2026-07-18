use criterion::{criterion_group, criterion_main, Criterion};
use std::hint::black_box;
use std::time::Duration;
use wabidb::engine::locks::ProjectionState;
use wabidb::projections::album_items::{self as ai, AlbumItemRecord, AlbumItemsProjection};
use wabidb::projections::albums::{self as alb, AlbumProjection, AlbumRecord};
use wabidb::projections::channel_members::{self as cm, ChannelMemberRecord, ChannelMembersProjection};
use wabidb::projections::dm_message_recipients::{self as dmr, DmMessageRecipientsProjection, DmRecipientRecord};
use wabidb::projections::dm_messages::{self as dm, DmMessageRecord, DmMessagesProjection};
use wabidb::projections::forum::{self as forum, ForumPostRecord, ForumProjection};
use wabidb::projections::incidents::{self as inc, IncidentProjection, IncidentRecord};
use wabidb::projections::messages::{self as msg, MessageRecord, MessagesProjection};
use wabidb::projections::reactions::{self as rxn, Reaction, ReactionsProjection};
use wabidb::projections::wiki::{self as wiki, WikiPageRecord, WikiProjection};

const N: usize = 10_000;
const GROUPS: usize = 100;

fn populate(state: &ProjectionState) {
    let per_group = N / GROUPS;

    // --- messages ---
    for g in 0..GROUPS {
        let ch = format!("ch_{g:04x}");
        for i in 0..per_group {
            let msgi = format!("msg_{g:04x}_{i:04x}");
            let r = MessageRecord {
                message_id: msgi.clone(),
                channel_id: ch.clone(),
                author_user_id: (g * per_group + i) as u64,
                author_device_id: "bench".into(),
                created_at_micros: (g * per_group + i) as i64 * 1000,
                encrypted_body_ref: format!("hash_{g}_{i}"),
                idempotency_key: None,
                edit_history: vec![],
                edited_at_micros: None,
                is_deleted: (g * per_group + i) % 10 == 0,
            };
            let key = msg::encode_key(&ch, &msgi);
            let val = msg::encode_record(&r);
            state.insert("messages", key, val, (g * per_group + i) as u64);
        }
    }

    // --- channel_members ---
    for g in 0..GROUPS {
        let ch = format!("ch_{g:04x}");
        for i in 0..per_group {
            let r = ChannelMemberRecord {
                channel_id: ch.clone(),
                user_id: (g * per_group + i) as u64,
                joined_at_micros: (g * per_group + i) as i64 * 1000,
                role: (i % 4) as u8,
                nick: None,
            };
            let key = cm::encode_key(&ch, r.user_id);
            let val = cm::encode_record(&r);
            state.insert("channel_members", key, val, (g * per_group + i) as u64);
        }
    }

    // --- dm_messages ---
    for g in 0..GROUPS {
        let dm_id = format!("dm_{g:04x}");
        for i in 0..per_group {
            let msgi = format!("dmsg_{g:04x}_{i:04x}");
            let r = DmMessageRecord {
                dm_id: dm_id.clone(),
                message_id: msgi.clone(),
                author_user_id: (g * per_group + i) as u64,
                author_device_id: "bench".into(),
                created_at_micros: (g * per_group + i) as i64 * 1000,
                encrypted_body_ref: format!("hash_{g}_{i}"),
                idempotency_key: None,
                edit_history: vec![],
            };
            let key = dm::encode_key(&dm_id, &msgi);
            let val = dm::encode_record(&r);
            state.insert("dm_messages", key, val, (g * per_group + i) as u64);
        }
    }

    // --- dm_message_recipients ---
    for g in 0..GROUPS {
        let dm_id = format!("dm_{g:04x}");
        for i in 0..per_group {
            let msgi = format!("dmsg_{g:04x}_{i:04x}");
            for u in 0..3 {
                let r = DmRecipientRecord {
                    dm_id: dm_id.clone(),
                    message_id: msgi.clone(),
                    recipient_user_id: (g * per_group * 3 + u) as u64,
                    delivered_at_micros: Some((g * per_group + i) as i64 * 1000),
                    read_at_micros: None,
                };
                let key = dmr::encode_key(&dm_id, &msgi, r.recipient_user_id);
                let val = dmr::encode_record(&r);
                state.insert("dm_message_recipients", key, val, (g * per_group * 3 + u) as u64);
            }
        }
    }

    // --- reactions ---
    let emojis = ["👍", "❤️", "🎉", "🚀", "👀"];
    for g in 0..GROUPS {
        let msgi = format!("msg_{g:04x}_0000");
        for (ei, &emoji) in emojis.iter().enumerate() {
            let r = Reaction {
                message_id: msgi.clone(),
                user_id: (g * 5 + ei) as u64,
                reaction_type: emoji.to_string(),
                created_at_micros: (g * 5 + ei) as i64 * 1000,
                key_id: "bench_key".into(),
            };
            let key = rxn::composite_key(&msgi, r.user_id, emoji);
            let val = rxn::encode_reaction(&r);
            state.insert("reactions", key, val, (g * 5 + ei) as u64);
        }
    }

    // --- wiki_pages ---
    for g in 0..GROUPS {
        let ch = format!("ch_{g:04x}");
        for i in 0..per_group {
            let page_id = format!("page_{g:04x}_{i:04x}");
            let r = WikiPageRecord {
                page_id: page_id.clone(),
                channel_id: ch.clone(),
                title: format!("Page {g}_{i}"),
                body: "body".into(),
                author_user_id: (g * per_group + i) as u64,
                created_at_micros: (g * per_group + i) as i64 * 1000,
                updated_at_micros: (g * per_group + i) as i64 * 1000,
                is_deleted: false,
                parent_page_id: String::new(),
                slug: String::new(),
                order_index: 0,
            };
            let key = wiki::encode_key(&ch, &page_id);
            let val = wiki::encode_record(&r);
            state.insert("wiki_pages", key, val, (g * per_group + i) as u64);
        }
    }

    // --- forum_posts ---
    for g in 0..GROUPS {
        let ch = format!("ch_{g:04x}");
        let thread_id = format!("thread_{g:04x}");
        for i in 0..per_group {
            let post_id = format!("post_{g:04x}_{i:04x}");
            let r = ForumPostRecord {
                post_id: post_id.clone(),
                thread_id: thread_id.clone(),
                channel_id: ch.clone(),
                author_user_id: (g * per_group + i) as u64,
                body: format!("Post {g}_{i}"),
                created_at_micros: (g * per_group + i) as i64 * 1000,
                edited_at_micros: None,
                is_deleted: i == 0,
                is_thread_starter: i == 0,
                title: String::new(),
                tags: Vec::new(),
                votes_up: 0,
                votes_down: 0,
                is_solution: false,
                category: None,
            };
            let key = forum::encode_key(&ch, &thread_id, &post_id);
            let val = forum::encode_record(&r);
            state.insert("forum_posts", key, val, (g * per_group + i) as u64);
        }
    }

    // --- incidents ---
    for g in 0..GROUPS {
        let ch = format!("ch_{g:04x}");
        for i in 0..per_group {
            let inc_id = format!("inc_{g:04x}_{i:04x}");
            let r = IncidentRecord {
                incident_id: inc_id.clone(),
                channel_id: ch.clone(),
                title: format!("Incident {g}_{i}"),
                description: "desc".into(),
                severity: if i % 3 == 0 { "high" } else { "low" }.into(),
                status: "open".into(),
                reporter_user_id: (g * per_group + i) as u64,
                assigned_user_id: None,
                created_at_micros: (g * per_group + i) as i64 * 1000,
                updated_at_micros: (g * per_group + i) as i64 * 1000,
                resolved_at_micros: None,
                is_deleted: i % 10 == 0,
            };
            let key = inc::encode_key(&ch, &inc_id);
            let val = inc::encode_record(&r);
            state.insert("incidents", key, val, (g * per_group + i) as u64);
        }
    }

    // --- albums + album_items ---
    for g in 0..GROUPS {
        let album_id = format!("alb_{g:04x}");
        let r = AlbumRecord {
            album_id: album_id.clone(),
            scope_type: "channel".into(),
            scope_id: format!("ch_{g:04x}"),
            name: format!("Album {g}"),
            description: String::new(),
            owner_user_id: g as u64,
            cover_url: String::new(),
            created_at_micros: g as i64 * 1000,
            updated_at_micros: g as i64 * 1000,
            is_deleted: g % 10 == 0,
        };
        let key = alb::encode_key("channel", &format!("ch_{g:04x}"), &album_id);
        let val = alb::encode_record(&r);
        state.insert("albums", key, val, g as u64);

        for i in 0..per_group {
            let item_id = format!("item_{g:04x}_{i:04x}");
            let r = AlbumItemRecord {
                item_id: item_id.clone(),
                album_id: album_id.clone(),
                url: format!("https://cdn.example.com/{g}_{i}.jpg"),
                name: format!("Item {g}_{i}"),
                size: Some(i as i64 * 1000),
                mime: Some("image/jpeg".into()),
                caption: None,
                sort_order: i as i64,
                created_at_micros: (g * per_group + i) as i64 * 1000,
                is_deleted: i % 10 == 0,
            };
            let key = ai::encode_key(&album_id, &item_id);
            let val = ai::encode_record(&r);
            state.insert("album_items", key, val, (g * per_group + i) as u64);
        }
    }
}

fn bench_get(c: &mut Criterion) {
    let state = ProjectionState::new();
    populate(&state);

    let mut group = c.benchmark_group("projection_get");
    group.measurement_time(Duration::from_secs(5));

    group.bench_function("get_message", |b| {
        b.iter(|| {
            let _ = MessagesProjection::get_message(black_box(&state), "ch_0000", "msg_0000_0000");
        });
    });
    group.bench_function("get_member", |b| {
        b.iter(|| {
            let _ = ChannelMembersProjection::get_member(black_box(&state), "ch_0000", 0);
        });
    });
    group.bench_function("get_dm_message", |b| {
        b.iter(|| {
            let _ = DmMessagesProjection::get_message(black_box(&state), "dm_0000", "dmsg_0000_0000");
        });
    });
    group.bench_function("get_recipient", |b| {
        b.iter(|| {
            let _ = DmMessageRecipientsProjection::get_recipient(black_box(&state), "dm_0000", "dmsg_0000_0000", 0);
        });
    });
    group.bench_function("get_reaction", |b| {
        b.iter(|| {
            let _ = ReactionsProjection::get_reaction(black_box(&state), "msg_0000_0000", 0, "👍");
        });
    });
    group.bench_function("get_page", |b| {
        b.iter(|| {
            let _ = WikiProjection::get_page(black_box(&state), "ch_0000", "page_0000_0000");
        });
    });
    group.bench_function("get_post", |b| {
        b.iter(|| {
            let _ = ForumProjection::get_post(black_box(&state), "ch_0000", "thread_0000", "post_0000_0000");
        });
    });
    group.bench_function("get_incident", |b| {
        b.iter(|| {
            let _ = IncidentProjection::get_incident(black_box(&state), "ch_0000", "inc_0000_0000");
        });
    });
    group.bench_function("get_album", |b| {
        b.iter(|| {
            let _ = AlbumProjection::get_album(black_box(&state), "channel", "ch_0000", "alb_0000");
        });
    });
    group.bench_function("get_album_item", |b| {
        b.iter(|| {
            let _ = AlbumItemsProjection::get_item(black_box(&state), "alb_0000", "item_0000_0000");
        });
    });
    group.finish();
}

fn bench_list(c: &mut Criterion) {
    let state = ProjectionState::new();
    populate(&state);

    let mut group = c.benchmark_group("projection_list");
    group.measurement_time(Duration::from_secs(5));

    group.bench_function("list_messages", |b| {
        b.iter(|| {
            let _ = MessagesProjection::list_messages(black_box(&state), "ch_0000", false);
        });
    });
    group.bench_function("list_messages_include_deleted", |b| {
        b.iter(|| {
            let _ = MessagesProjection::list_messages(black_box(&state), "ch_0000", true);
        });
    });
    group.bench_function("list_members", |b| {
        b.iter(|| {
            let _ = ChannelMembersProjection::list_members(black_box(&state), "ch_0000");
        });
    });
    group.bench_function("list_dm_messages", |b| {
        b.iter(|| {
            let _ = DmMessagesProjection::list_messages(black_box(&state), "dm_0000");
        });
    });
    group.bench_function("list_recipients", |b| {
        b.iter(|| {
            let _ = DmMessageRecipientsProjection::list_recipients(black_box(&state), "dm_0000", "dmsg_0000_0000");
        });
    });
    group.bench_function("list_reactions", |b| {
        b.iter(|| {
            let _ = ReactionsProjection::list_reactions(black_box(&state), "msg_0000_0000");
        });
    });
    group.bench_function("list_pages", |b| {
        b.iter(|| {
            let _ = WikiProjection::list_pages(black_box(&state), "ch_0000", false);
        });
    });
    group.bench_function("list_posts", |b| {
        b.iter(|| {
            let _ = ForumProjection::list_posts(black_box(&state), "ch_0000", "thread_0000", false);
        });
    });
    group.bench_function("list_threads", |b| {
        b.iter(|| {
            let _ = ForumProjection::list_threads(black_box(&state), "ch_0000", false);
        });
    });
    group.bench_function("list_incidents", |b| {
        b.iter(|| {
            let _ = IncidentProjection::list_incidents(black_box(&state), "ch_0000", false);
        });
    });
    group.bench_function("list_albums", |b| {
        b.iter(|| {
            let _ = AlbumProjection::list_albums(black_box(&state), "channel", "ch_0000", false);
        });
    });
    group.bench_function("list_album_items", |b| {
        b.iter(|| {
            let _ = AlbumItemsProjection::list_items(black_box(&state), "alb_0000", false);
        });
    });
    group.finish();
}

fn bench_compact(c: &mut Criterion) {
    let state = ProjectionState::new();
    populate(&state);

    let mut group = c.benchmark_group("projection_compact");
    group.measurement_time(Duration::from_secs(5));

    group.bench_function("compact_messages", |b| {
        b.iter(|| {
            let _ = MessagesProjection::compact(black_box(&state));
        });
    });

    group.finish();
}

criterion_group! {
    name = projection_read;
    config = Criterion::default().sample_size(20).measurement_time(Duration::from_secs(3));
    targets = bench_get, bench_list, bench_compact
}
criterion_main!(projection_read);
