//! Golden bytes for every durable postcard record type (Task 3.1).
//!
//! Each `*_LEGACY` hex literal is the exact encoding that the code *before*
//! versioning produced for the sample value next to it. Stored data written by
//! those builds looks like this, so the literals must never be regenerated: if
//! one stops decoding to its sample, the decoder is wrong, not the literal.

use crate::error::Result;
use std::fmt::Debug;

fn bytes(hex_literal: &str) -> Vec<u8> {
    hex::decode(hex_literal).expect("golden literal is valid hex")
}

/// After conversion: the golden bytes still decode to the sample (legacy
/// path), and the encoder writes a version-1 record with `tag` whose payload
/// is the same postcard body, i.e. no field changed.
fn converted<T: PartialEq + Debug>(
    legacy_hex: &str,
    tag: &[u8; 4],
    sample: &T,
    encode: impl Fn(&T) -> Vec<u8>,
    decode: impl Fn(&[u8]) -> Result<T>,
) {
    use crate::format::versioned::{is_versioned, HEADER_LEN, MARKER};
    let legacy = bytes(legacy_hex);
    assert!(!is_versioned(&legacy), "golden literal must be unversioned");
    assert_eq!(&decode(&legacy).expect("legacy bytes decode"), sample);
    let encoded = encode(sample);
    assert_eq!(&encoded[..MARKER.len()], &MARKER);
    assert_eq!(&encoded[MARKER.len()..MARKER.len() + 4], tag);
    assert_eq!(encoded[MARKER.len() + 4], 1, "version byte");
    assert_eq!(hex::encode(&encoded[HEADER_LEN..]), legacy_hex, "payload layout changed");
    assert_eq!(&decode(&encoded).expect("versioned bytes decode"), sample);
}

use crate::domain::{Emote, UserLayout, Webhook, WhiteboardDoc};
use crate::projections::{
    album_items::{self, AlbumItemRecord},
    albums::{self, AlbumRecord},
    channel_members::{self, ChannelMemberRecord},
    codec::RecordCodec,
    dm_identities::{self, DmIdentityRecord},
    dm_message_recipients::{self, DmRecipientRecord},
    dm_messages::{self, DmMessageRecord},
    emotes,
    forum::{self, ForumPostRecord},
    gallery::{self, GalleryFeedbackRecord, GalleryWorkRecord},
    incidents::{self, IncidentRecord},
    layouts,
    lore::{
        self, LoreBindingRecord, LoreCommitRecord, LoreFileChangeRecord, LorePromoteRecord,
        LoreRepoRecord, LoreTokenRecord,
    },
    messages::{self, FileAttachmentRecord, MessageRecord},
    payments::{
        PaymentAccountLinkRecord, PaymentDeleteKey, PaymentIntentRecord, PaymentPolicyRecord,
        PaymentUserBlockRecord,
    },
    reactions::{self, Reaction},
    users::{self, UserRecord},
    webhooks, whiteboard_docs,
    wiki::{self, WikiPageRecord, WikiRevisionRecord},
};

// ---------------------------------------------------------------------------
// Samples. Representative values: Some and None, non-empty sequences,
// negative and large integers, non-ASCII text.
// ---------------------------------------------------------------------------

pub(crate) fn channel_member() -> ChannelMemberRecord {
    ChannelMemberRecord {
        channel_id: "ch_general".into(),
        user_id: 4_200_000_001,
        joined_at_micros: 1_730_000_000_000_001,
        role: 2,
        nick: Some("Mira ✿".into()),
    }
}

pub(crate) fn dm_message() -> DmMessageRecord {
    DmMessageRecord {
        dm_id: "dm_7_9".into(),
        message_id: "0192e3c4-5b6a-7c8d-9e0f-a1b2c3d4e5f6".into(),
        author_user_id: 7,
        author_device_id: "dev-laptop".into(),
        created_at_micros: 1_730_000_000_000_002,
        encrypted_body_ref: "sha256:5f3c".into(),
        idempotency_key: Some("idem-1".into()),
        edit_history: vec![(1_730_000_000_000_000, "sha256:aa".into()), (-1, "x".into())],
    }
}

pub(crate) fn dm_recipient() -> DmRecipientRecord {
    DmRecipientRecord {
        dm_id: "dm_7_9".into(),
        message_id: "0192e3c4-5b6a-7c8d-9e0f-a1b2c3d4e5f6".into(),
        recipient_user_id: 9,
        delivered_at_micros: Some(1_730_000_000_000_003),
        read_at_micros: None,
    }
}

pub(crate) fn dm_identity() -> DmIdentityRecord {
    DmIdentityRecord {
        user_id: 9,
        device_id: "dev-phone".into(),
        identity_key: "ik-base64".into(),
        signed_pre_key: "spk-base64".into(),
        signed_pre_key_signature: "sig-base64".into(),
        one_time_prekeys: vec!["otk1".into(), "otk2".into()],
        created_at_micros: 1_730_000_000_000_004,
        last_seen_micros: 1_730_000_000_000_005,
    }
}

pub(crate) fn reaction() -> Reaction {
    Reaction {
        message_id: "0192e3c4-5b6a-7c8d-9e0f-a1b2c3d4e5f6".into(),
        user_id: 7,
        reaction_type: "🎉".into(),
        created_at_micros: 1_730_000_000_000_006,
        key_id: "key-3".into(),
    }
}

pub(crate) fn emote() -> Emote {
    Emote {
        emote_id: "em_1".into(),
        name: "party".into(),
        image_url: "/uploads/party.png".into(),
        created_at_micros: 1_730_000_000_000_007,
        created_by_user_id: 7,
        display_name: "Party".into(),
        artist: "Kai".into(),
        category: "fun".into(),
        kind: "static".into(),
    }
}

pub(crate) fn webhook() -> Webhook {
    Webhook {
        webhook_id: "wh_1".into(),
        channel_id: "ch_general".into(),
        name: "CI".into(),
        url: "https://example.invalid/hook".into(),
        created_at_micros: 1_730_000_000_000_008,
        created_by_user_id: 7,
    }
}

pub(crate) fn user_layout() -> UserLayout {
    UserLayout {
        user_id: 7,
        layout_json: r#"{"dock":["chat","wiki"]}"#.into(),
        updated_at_micros: 1_730_000_000_000_009,
    }
}

pub(crate) fn whiteboard_doc() -> WhiteboardDoc {
    WhiteboardDoc {
        board_id: "wb_1".into(),
        doc_json: r#"{"shapes":[{"t":"rect"}]}"#.into(),
        updated_at_micros: 1_730_000_000_000_010,
    }
}

pub(crate) fn album() -> AlbumRecord {
    AlbumRecord {
        album_id: "alb_1".into(),
        scope_type: "channel".into(),
        scope_id: "ch_general".into(),
        name: "Trip".into(),
        description: "Spring trip".into(),
        owner_user_id: 7,
        cover_url: "/uploads/cover.jpg".into(),
        created_at_micros: 1_730_000_000_000_011,
        updated_at_micros: 1_730_000_000_000_012,
        is_deleted: false,
    }
}

pub(crate) fn album_item() -> AlbumItemRecord {
    AlbumItemRecord {
        item_id: "ali_1".into(),
        album_id: "alb_1".into(),
        url: "/uploads/a.jpg".into(),
        name: "a.jpg".into(),
        size: Some(123_456),
        mime: Some("image/jpeg".into()),
        caption: None,
        sort_order: -3,
        created_at_micros: 1_730_000_000_000_013,
        is_deleted: true,
    }
}

pub(crate) fn wiki_page() -> WikiPageRecord {
    WikiPageRecord {
        page_id: "page_1".into(),
        channel_id: "ch_general".into(),
        title: "Rules".into(),
        body: "# Rules\nBe kind.".into(),
        author_user_id: 7,
        created_at_micros: 1_730_000_000_000_014,
        updated_at_micros: 1_730_000_000_000_015,
        is_deleted: false,
        parent_page_id: "page_0".into(),
        slug: "rules".into(),
        order_index: 2,
    }
}

pub(crate) fn wiki_revision() -> WikiRevisionRecord {
    WikiRevisionRecord {
        revision_id: "rev_1".into(),
        page_id: "page_1".into(),
        channel_id: "ch_general".into(),
        editor_user_id: 9,
        title: "Rules".into(),
        body: "# Rules\nBe kind!".into(),
        summary: "punctuation".into(),
        created_at_micros: 1_730_000_000_000_016,
    }
}

pub(crate) fn forum_post() -> ForumPostRecord {
    ForumPostRecord {
        post_id: "post_1".into(),
        thread_id: "thr_1".into(),
        channel_id: "ch_forum".into(),
        author_user_id: 7,
        body: "How do I export?".into(),
        created_at_micros: 1_730_000_000_000_017,
        edited_at_micros: Some(1_730_000_000_000_018),
        is_deleted: false,
        is_thread_starter: true,
        title: "Export".into(),
        tags: vec!["help".into(), "export".into()],
        votes_up: 3,
        votes_down: 1,
        is_solution: false,
        category: Some("support".into()),
    }
}

pub(crate) fn incident() -> IncidentRecord {
    IncidentRecord {
        incident_id: "inc_1".into(),
        channel_id: "ch_ops".into(),
        title: "Uploads failing".into(),
        description: "413 on large files".into(),
        severity: "high".into(),
        status: "resolved".into(),
        reporter_user_id: 7,
        assigned_user_id: Some(9),
        created_at_micros: 1_730_000_000_000_019,
        updated_at_micros: 1_730_000_000_000_020,
        resolved_at_micros: Some(1_730_000_000_000_021),
        is_deleted: false,
    }
}

pub(crate) fn gallery_work() -> GalleryWorkRecord {
    GalleryWorkRecord {
        work_id: "gw_1".into(),
        channel_id: "ch_art".into(),
        author_user_id: 7,
        title: "Fox".into(),
        caption: "ink".into(),
        attachment_url: "/uploads/fox.png".into(),
        mime_type: "image/png".into(),
        category: "illustration".into(),
        is_wip: true,
        created_at_micros: 1_730_000_000_000_022,
        updated_at_micros: 1_730_000_000_000_023,
        is_deleted: false,
    }
}

pub(crate) fn gallery_feedback() -> GalleryFeedbackRecord {
    GalleryFeedbackRecord {
        feedback_id: "gf_1".into(),
        work_id: "gw_1".into(),
        channel_id: "ch_art".into(),
        author_user_id: 9,
        comment: "Lovely tail".into(),
        x_percent: 41.5,
        y_percent: 0.25,
        created_at_micros: 1_730_000_000_000_024,
        is_deleted: false,
    }
}

pub(crate) fn lore_repo() -> LoreRepoRecord {
    LoreRepoRecord {
        channel_id: -42,
        repo_name: "game-assets".into(),
        lore_server_url: "http://lore.invalid:7300".into(),
        created_by: 7,
        created_at_micros: 1_730_000_000_000_025,
    }
}

pub(crate) fn lore_commit() -> LoreCommitRecord {
    LoreCommitRecord {
        commit_hash: "9f86d081884c7d65".into(),
        channel_id: 42,
        repo_name: "game-assets".into(),
        file_path: "textures/fox.png".into(),
        message: "Add fox texture".into(),
        author_user_id: 7,
        timestamp_micros: 1_730_000_000_000_026,
    }
}

pub(crate) fn lore_file_change() -> LoreFileChangeRecord {
    LoreFileChangeRecord {
        seq: 3,
        channel_id: 42,
        path: "textures/fox.png".into(),
        action: "modified".into(),
        etag: Some("\"e1\"".into()),
        revision: "9f86d081884c7d65".into(),
        author_user_id: 7,
        timestamp_micros: 1_730_000_000_000_027,
    }
}

pub(crate) fn lore_token() -> LoreTokenRecord {
    LoreTokenRecord {
        token_hash: "blake3:abcd".into(),
        channel_id: 42,
        user_id: 7,
        scopes: "read,write".into(),
        created_at_micros: 1_730_000_000_000_028,
        revoked: true,
    }
}

pub(crate) fn lore_binding() -> LoreBindingRecord {
    LoreBindingRecord {
        channel_id: 43,
        repo_channel_id: 42,
        path: "screenshots/".into(),
        branch: "main".into(),
        mode: "review".into(),
        allowed_types: vec!["image/*".into(), "model/gltf-binary".into()],
        auto_stage: true,
        updated_by: 7,
        updated_at_micros: 1_730_000_000_000_029,
    }
}

pub(crate) fn lore_promote() -> LorePromoteRecord {
    LorePromoteRecord {
        message_id: "0192e3c4-5b6a-7c8d-9e0f-a1b2c3d4e5f6".into(),
        channel_id: 43,
        repo_channel_id: 42,
        file_url: "/uploads/shot.png".into(),
        file_name: "shot.png".into(),
        path: "screenshots/shot.png".into(),
        branch: "main".into(),
        mode: "review".into(),
        revision_hash: "1a2b3c".into(),
        pending_review: true,
        review_branch: Some("review/shot".into()),
        promoted_by: 7,
        timestamp_micros: 1_730_000_000_000_030,
    }
}

pub(crate) fn payment_account_link() -> PaymentAccountLinkRecord {
    PaymentAccountLinkRecord {
        user_id: 7,
        workspace_id: "default".into(),
        plugin_id: "promptpay".into(),
        provider_account_ref: "0812345678".into(),
        display_label: Some("Main".into()),
        // Postcard cannot decode serde_json::Value; the API refuses metadata.
        metadata: None,
        linked_at: 1_730_000_000_031,
        updated_at: 1_730_000_000_032,
    }
}

pub(crate) fn payment_intent() -> PaymentIntentRecord {
    PaymentIntentRecord {
        id: "pi_1".into(),
        user_id: 7,
        provider: "promptpay".into(),
        amount_minor: 15_000,
        currency: "THB".into(),
        status: "completed".into(),
        method_id: Some("promptpay-qr".into()),
        country_code: Some("TH".into()),
        presentation_json: None,
        promptpay_proxy_id: Some("0812345678".into()),
        promptpay_qr_payload: Some("000201010211".into()),
        note: Some("dues".into()),
        created_at: 1_730_000_000_033,
        updated_at: 1_730_000_000_034,
        confirmed_by: Some(1),
        confirm_note: None,
    }
}

pub(crate) fn payment_policy() -> PaymentPolicyRecord {
    PaymentPolicyRecord {
        key: "payments.enabled".into(),
        value_json: "true".into(),
    }
}

pub(crate) fn payment_user_block() -> PaymentUserBlockRecord {
    PaymentUserBlockRecord {
        user_id: 9,
        workspace_id: "default".into(),
        reason: Some("chargeback".into()),
        blocked_by_user_id: Some(1),
        blocked_by_username: Some("owner".into()),
        blocked_username: None,
        blocked_at: 1_730_000_000_035,
        expires_at: Some(1_730_000_000_036),
    }
}

pub(crate) fn payment_delete_key() -> PaymentDeleteKey {
    PaymentDeleteKey {
        user_id: 7,
        workspace_id: Some("default".into()),
        plugin_id: None,
    }
}

pub(crate) fn message() -> MessageRecord {
    MessageRecord {
        message_id: "0192e3c4-5b6a-7c8d-9e0f-a1b2c3d4e5f6".into(),
        channel_id: "ch_general".into(),
        author_user_id: 7,
        author_device_id: "dev-laptop".into(),
        created_at_micros: 1_730_000_000_000_037,
        encrypted_body_ref: "hello, wabi ✿".into(),
        idempotency_key: Some("idem-2".into()),
        edit_history: vec![(1_730_000_000_000_036, "hello".into())],
        edited_at_micros: Some(1_730_000_000_000_038),
        is_deleted: false,
        is_spoiler: true,
        files: vec![FileAttachmentRecord {
            file_url: "/uploads/a.pdf".into(),
            file_name: "a.pdf".into(),
            file_size: 98_765,
        }],
    }
}

/// The message as a pre-`is_spoiler` (V0) record decodes: no spoiler, no files.
pub(crate) fn message_v0_decoded() -> MessageRecord {
    MessageRecord {
        is_spoiler: false,
        files: vec![],
        ..message()
    }
}

pub(crate) fn user() -> UserRecord {
    UserRecord {
        user_id: 7,
        username: "mira".into(),
        handle: Some("mira#0007".into()),
        color: "#c0ffee".into(),
        password_hash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA".into(),
        is_registered: true,
        is_active: true,
        created_at_micros: 1_730_000_000_000_039,
        last_seen_micros: 1_730_000_000_000_040,
        profile_picture: Some("/uploads/mira.png".into()),
        username_font: None,
        bio: Some("draws foxes".into()),
        status_message: Some("away ✿".into()),
    }
}

/// The user as a pre-profile-fields (V1) record decodes: no profile fields.
pub(crate) fn user_v1_decoded() -> UserRecord {
    UserRecord {
        profile_picture: None,
        username_font: None,
        bio: None,
        status_message: None,
        ..user()
    }
}

// ---------------------------------------------------------------------------
// Golden literals, captured from the encoders before Task 3.1 changed them.
// ---------------------------------------------------------------------------
const CHANNEL_MEMBER_LEGACY: &str =
    "0a63685f67656e6572616c81d4dbd20f8280b1b7a0db92060201084d69726120e29cbf";
const DM_MESSAGE_LEGACY: &str =
    "06646d5f375f392430313932653363342d356236612d376338642d396530662d613162326333643465356636070a6465762d6c6170746f708480b1b7a0db92060b7368613235363a3566336301066964656d2d31028080b1b7a0db9206097368613235363a6161010178";
const DM_RECIPIENT_LEGACY: &str =
    "06646d5f375f392430313932653363342d356236612d376338642d396530662d61316232633364346535663609018680b1b7a0db920600";
const DM_IDENTITY_LEGACY: &str =
    "09096465762d70686f6e6509696b2d6261736536340a73706b2d6261736536340a7369672d62617365363402046f746b31046f746b328880b1b7a0db92068a80b1b7a0db9206";
const REACTION_LEGACY: &str =
    "2430313932653363342d356236612d376338642d396530662d6131623263336434653566360704f09f8e898c80b1b7a0db9206056b65792d33";
const EMOTE_LEGACY: &str =
    "04656d5f31057061727479122f75706c6f6164732f70617274792e706e678e80b1b7a0db920607055061727479034b61690366756e06737461746963";
const WEBHOOK_LEGACY: &str =
    "0477685f310a63685f67656e6572616c0243491c68747470733a2f2f6578616d706c652e696e76616c69642f686f6f6b9080b1b7a0db920607";
const USER_LAYOUT_LEGACY: &str =
    "07187b22646f636b223a5b2263686174222c2277696b69225d7d9280b1b7a0db9206";
const WHITEBOARD_DOC_LEGACY: &str =
    "0477625f31197b22736861706573223a5b7b2274223a2272656374227d5d7d9480b1b7a0db9206";
const ALBUM_LEGACY: &str =
    "05616c625f31076368616e6e656c0a63685f67656e6572616c04547269700b537072696e67207472697007122f75706c6f6164732f636f7665722e6a70679680b1b7a0db92069880b1b7a0db920600";
const ALBUM_ITEM_LEGACY: &str =
    "05616c695f3105616c625f310e2f75706c6f6164732f612e6a706705612e6a70670180890f010a696d6167652f6a70656700059a80b1b7a0db920601";
const WIKI_PAGE_LEGACY: &str =
    "06706167655f310a63685f67656e6572616c0552756c657310232052756c65730a4265206b696e642e079c80b1b7a0db92069e80b1b7a0db92060006706167655f300572756c657304";
const WIKI_REVISION_LEGACY: &str =
    "057265765f3106706167655f310a63685f67656e6572616c090552756c657310232052756c65730a4265206b696e64210b70756e6374756174696f6ea080b1b7a0db9206";
const FORUM_POST_LEGACY: &str =
    "06706f73745f31057468725f310863685f666f72756d0710486f7720646f2049206578706f72743fa280b1b7a0db920601a480b1b7a0db92060001064578706f7274020468656c70066578706f72740301000107737570706f7274";
const INCIDENT_LEGACY: &str =
    "05696e635f310663685f6f70730f55706c6f616473206661696c696e6712343133206f6e206c617267652066696c65730468696768087265736f6c766564070109a680b1b7a0db9206a880b1b7a0db920601aa80b1b7a0db920600";
const GALLERY_WORK_LEGACY: &str =
    "0467775f310663685f6172740703466f7803696e6b102f75706c6f6164732f666f782e706e6709696d6167652f706e670c696c6c757374726174696f6e01ac80b1b7a0db9206ae80b1b7a0db920600";
const GALLERY_FEEDBACK_LEGACY: &str =
    "0467665f310467775f310663685f617274090b4c6f76656c79207461696c000026420000803eb080b1b7a0db920600";
const LORE_REPO_LEGACY: &str =
    "530b67616d652d61737365747318687474703a2f2f6c6f72652e696e76616c69643a373330300eb280b1b7a0db9206";
const LORE_COMMIT_LEGACY: &str =
    "1039663836643038313838346337643635540b67616d652d6173736574731074657874757265732f666f782e706e670f41646420666f7820746578747572650eb480b1b7a0db9206";
const LORE_FILE_CHANGE_LEGACY: &str =
    "03541074657874757265732f666f782e706e67086d6f64696669656401042265312210396638366430383138383463376436350eb680b1b7a0db9206";
const LORE_TOKEN_LEGACY: &str =
    "0b626c616b65333a61626364540e0a726561642c7772697465b880b1b7a0db920601";
const LORE_BINDING_LEGACY: &str =
    "56540c73637265656e73686f74732f046d61696e067265766965770207696d6167652f2a116d6f64656c2f676c74662d62696e617279010eba80b1b7a0db9206";
const LORE_PROMOTE_LEGACY: &str =
    "2430313932653363342d356236612d376338642d396530662d6131623263336434653566365654112f75706c6f6164732f73686f742e706e670873686f742e706e671473637265656e73686f74732f73686f742e706e67046d61696e067265766965770631613262336301010b7265766965772f73686f740ebc80b1b7a0db9206";
const PAYMENT_ACCOUNT_LINK_LEGACY: &str =
    "0e0764656661756c740970726f6d70747061790a3038313233343536373801044d61696e00bed0c8c0d964c0d0c8c0d964";
const PAYMENT_INTENT_LEGACY: &str =
    "0470695f310e0970726f6d7074706179b0ea010354484209636f6d706c65746564010c70726f6d70747061792d71720102544800010a30383132333435363738010c303030323031303130323131010464756573c2d0c8c0d964c4d0c8c0d964010200";
const PAYMENT_POLICY_LEGACY: &str =
    "107061796d656e74732e656e61626c65640474727565";
const PAYMENT_USER_BLOCK_LEGACY: &str =
    "120764656661756c74010a6368617267656261636b010201056f776e657200c6d0c8c0d96401c8d0c8c0d964";
const PAYMENT_DELETE_KEY_LEGACY: &str =
    "0e010764656661756c7400";
const MESSAGE_LEGACY: &str =
    "2430313932653363342d356236612d376338642d396530662d6131623263336434653566360a63685f67656e6572616c070a6465762d6c6170746f70ca80b1b7a0db92060f68656c6c6f2c207761626920e29cbf01066964656d2d3201c880b1b7a0db92060568656c6c6f01cc80b1b7a0db92060001010e2f75706c6f6164732f612e70646605612e706466cd8306";
const USER_LEGACY: &str =
    "07046d69726101096d697261233030303707236330666665652c246172676f6e32696424763d3139246d3d31393435362c743d322c703d3124633246736441246147467a61410101ce80b1b7a0db9206d080b1b7a0db920601112f75706c6f6164732f6d6972612e706e6700010b647261777320666f78657301086177617920e29cbf";
/// `MessageRecord` before `is_spoiler` and `files` (decoded by the V0 fallback).
const MESSAGE_V0_LEGACY: &str =
    "2430313932653363342d356236612d376338642d396530662d6131623263336434653566360a63685f67656e6572616c070a6465762d6c6170746f70ca80b1b7a0db92060f68656c6c6f2c207761626920e29cbf01066964656d2d3201c880b1b7a0db92060568656c6c6f01cc80b1b7a0db920600";
/// `UserRecord` before the profile fields (decoded by the V1 fallback).
const USER_V1_LEGACY: &str =
    "07046d69726101096d697261233030303707236330666665652c246172676f6e32696424763d3139246d3d31393435362c743d322c703d3124633246736441246147467a61410101ce80b1b7a0db9206d080b1b7a0db9206";

// ---------------------------------------------------------------------------
// One golden test per record type.
// ---------------------------------------------------------------------------

#[test]
fn golden_channel_member_record() {
    converted(CHANNEL_MEMBER_LEGACY, b"CMEM", &channel_member(), channel_members::encode_record, channel_members::decode_record);
}

#[test]
fn golden_dm_message_record() {
    converted(DM_MESSAGE_LEGACY, b"DMSG", &dm_message(), dm_messages::encode_record, dm_messages::decode_record);
}

#[test]
fn golden_dm_recipient_record() {
    converted(DM_RECIPIENT_LEGACY, b"DRCP", &dm_recipient(), dm_message_recipients::encode_record, dm_message_recipients::decode_record);
}

#[test]
fn golden_dm_identity_record() {
    converted(DM_IDENTITY_LEGACY, b"DIDN", &dm_identity(), dm_identities::encode_record, dm_identities::decode_record);
}

#[test]
fn golden_reaction() {
    converted(REACTION_LEGACY, b"RACT", &reaction(), reactions::encode_reaction, reactions::decode_reaction);
}

#[test]
fn golden_emote() {
    converted(EMOTE_LEGACY, b"EMOT", &emote(), emotes::encode_record, emotes::decode_record);
}

#[test]
fn golden_webhook() {
    converted(WEBHOOK_LEGACY, b"WHOK", &webhook(), webhooks::encode_record, webhooks::decode_record);
}

#[test]
fn golden_user_layout() {
    converted(USER_LAYOUT_LEGACY, b"ULAY", &user_layout(), layouts::encode_record, layouts::decode_record);
}

#[test]
fn golden_whiteboard_doc() {
    converted(WHITEBOARD_DOC_LEGACY, b"WBDC", &whiteboard_doc(), whiteboard_docs::encode_record, whiteboard_docs::decode_record);
}

#[test]
fn golden_album_record() {
    converted(ALBUM_LEGACY, b"ALBM", &album(), albums::encode_record, albums::decode_record);
}

#[test]
fn golden_album_item_record() {
    converted(ALBUM_ITEM_LEGACY, b"ALIT", &album_item(), album_items::encode_record, album_items::decode_record);
}

#[test]
fn golden_wiki_page_record() {
    converted(WIKI_PAGE_LEGACY, b"WPAG", &wiki_page(), wiki::encode_record, wiki::decode_record);
}

#[test]
fn golden_wiki_revision_record() {
    converted(WIKI_REVISION_LEGACY, b"WREV", &wiki_revision(), wiki::encode_revision_record, wiki::decode_revision_record);
}

#[test]
fn golden_forum_post_record() {
    converted(FORUM_POST_LEGACY, b"FPST", &forum_post(), forum::encode_record, forum::decode_record);
}

#[test]
fn golden_incident_record() {
    converted(INCIDENT_LEGACY, b"INCD", &incident(), incidents::encode_record, incidents::decode_record);
}

#[test]
fn golden_gallery_work_record() {
    converted(GALLERY_WORK_LEGACY, b"GWRK", &gallery_work(), gallery::encode_record, gallery::decode_record);
}

#[test]
fn golden_gallery_feedback_record() {
    converted(GALLERY_FEEDBACK_LEGACY, b"GFBK", &gallery_feedback(), gallery::encode_feedback_record, gallery::decode_feedback_record);
}

#[test]
fn golden_lore_repo_record() {
    converted(LORE_REPO_LEGACY, b"LREP", &lore_repo(), lore::encode_repo_record, lore::decode_repo_record);
}

#[test]
fn golden_lore_commit_record() {
    converted(LORE_COMMIT_LEGACY, b"LCOM", &lore_commit(), lore::encode_record, lore::decode_record);
}

#[test]
fn golden_lore_file_change_record() {
    converted(LORE_FILE_CHANGE_LEGACY, b"LCHG", &lore_file_change(), lore::encode_change_record, lore::decode_change_record);
}

#[test]
fn golden_lore_token_record() {
    converted(LORE_TOKEN_LEGACY, b"LTOK", &lore_token(), lore::encode_token_record, lore::decode_token_record);
}

#[test]
fn golden_lore_binding_record() {
    converted(LORE_BINDING_LEGACY, b"LBND", &lore_binding(), lore::encode_binding_record, lore::decode_binding_record);
}

#[test]
fn golden_lore_promote_record() {
    converted(LORE_PROMOTE_LEGACY, b"LPRM", &lore_promote(), lore::encode_promote_record, lore::decode_promote_record);
}

#[test]
fn golden_payment_account_link_record() {
    converted(PAYMENT_ACCOUNT_LINK_LEGACY, b"PLNK", &payment_account_link(), PaymentAccountLinkRecord::encode, PaymentAccountLinkRecord::decode);
}

#[test]
fn golden_payment_intent_record() {
    converted(PAYMENT_INTENT_LEGACY, b"PINT", &payment_intent(), PaymentIntentRecord::encode, PaymentIntentRecord::decode);
}

#[test]
fn golden_payment_policy_record() {
    converted(PAYMENT_POLICY_LEGACY, b"PPOL", &payment_policy(), PaymentPolicyRecord::encode, PaymentPolicyRecord::decode);
}

#[test]
fn golden_payment_user_block_record() {
    converted(PAYMENT_USER_BLOCK_LEGACY, b"PBLK", &payment_user_block(), PaymentUserBlockRecord::encode, PaymentUserBlockRecord::decode);
}

#[test]
fn golden_payment_delete_key() {
    converted(PAYMENT_DELETE_KEY_LEGACY, b"PDEL", &payment_delete_key(), PaymentDeleteKey::encode, PaymentDeleteKey::decode);
}

#[test]
fn golden_message_record() {
    converted(MESSAGE_LEGACY, b"MESG", &message(), messages::encode_record, messages::decode_record);
}

#[test]
fn golden_user_record() {
    converted(USER_LEGACY, b"USER", &user(), users::encode_record, users::decode_record);
}

#[test]
fn golden_message_record_v0() {
    let decoded = messages::decode_record(&bytes(MESSAGE_V0_LEGACY)).unwrap();
    assert_eq!(decoded, message_v0_decoded());
}

#[test]
fn golden_user_record_v1() {
    let decoded = users::decode_record(&bytes(USER_V1_LEGACY)).unwrap();
    assert_eq!(decoded, user_v1_decoded());
}

/// Every durable record type above writes the versioned header.
#[test]
fn every_durable_record_is_versioned() {
    let encoded: Vec<(&str, Vec<u8>)> = vec![
        ("ChannelMemberRecord", channel_members::encode_record(&channel_member())),
        ("DmMessageRecord", dm_messages::encode_record(&dm_message())),
        ("DmRecipientRecord", dm_message_recipients::encode_record(&dm_recipient())),
        ("DmIdentityRecord", dm_identities::encode_record(&dm_identity())),
        ("Reaction", reactions::encode_reaction(&reaction())),
        ("Emote", emotes::encode_record(&emote())),
        ("Webhook", webhooks::encode_record(&webhook())),
        ("UserLayout", layouts::encode_record(&user_layout())),
        ("WhiteboardDoc", whiteboard_docs::encode_record(&whiteboard_doc())),
        ("AlbumRecord", albums::encode_record(&album())),
        ("AlbumItemRecord", album_items::encode_record(&album_item())),
        ("WikiPageRecord", wiki::encode_record(&wiki_page())),
        ("WikiRevisionRecord", wiki::encode_revision_record(&wiki_revision())),
        ("ForumPostRecord", forum::encode_record(&forum_post())),
        ("IncidentRecord", incidents::encode_record(&incident())),
        ("GalleryWorkRecord", gallery::encode_record(&gallery_work())),
        ("GalleryFeedbackRecord", gallery::encode_feedback_record(&gallery_feedback())),
        ("LoreRepoRecord", lore::encode_repo_record(&lore_repo())),
        ("LoreCommitRecord", lore::encode_record(&lore_commit())),
        ("LoreFileChangeRecord", lore::encode_change_record(&lore_file_change())),
        ("LoreTokenRecord", lore::encode_token_record(&lore_token())),
        ("LoreBindingRecord", lore::encode_binding_record(&lore_binding())),
        ("LorePromoteRecord", lore::encode_promote_record(&lore_promote())),
        ("PaymentAccountLinkRecord", payment_account_link().encode()),
        ("PaymentIntentRecord", payment_intent().encode()),
        ("PaymentPolicyRecord", payment_policy().encode()),
        ("PaymentUserBlockRecord", payment_user_block().encode()),
        ("PaymentDeleteKey", payment_delete_key().encode()),
        ("MessageRecord", messages::encode_record(&message())),
        ("UserRecord", users::encode_record(&user())),
    ];
    let unversioned: Vec<&str> = encoded
        .iter()
        .filter(|(_, bytes)| !crate::format::versioned::is_versioned(bytes))
        .map(|(name, _)| *name)
        .collect();
    assert!(unversioned.is_empty(), "unversioned durable records: {unversioned:?}");
}

// ---------------------------------------------------------------------------
// Event payloads (Task 3.1b). These are not projection rows: each is the
// payload of one durable event, decoded by its handler on every replay. The
// literals were captured from the encoders before Task 3.1b changed them.
// ---------------------------------------------------------------------------

/// `forum_post_voted`: post, thread, channel, direction, actor.
const FORUM_VOTE_LEGACY: &str =
    "06706f73745f31057468725f310863685f666f72756d02757081d4dbd20f";
/// `forum_post_solution_set`: post, thread, channel, actor.
const FORUM_SOLUTION_LEGACY: &str =
    "06706f73745f31057468725f310863685f666f72756d81d4dbd20f";
/// `user_deleted`: the deleted user's id.
const USER_DELETED_LEGACY: &str = "81d4dbd20f";
/// `dm_onetime_prekey_consumed`: user, device, prekey.
const DM_PREKEY_CONSUMED_LEGACY: &str = "09096465762d70686f6e65046f746b31";

/// The encoders as they were before Task 3.1b. The vote and solution structs
/// are verbatim copies of the private structs in wabi-server's
/// `adapter::vote_forum_post` and `adapter::mark_forum_solution`; the consumed
/// struct is a copy of the one the dm_identities tests encode (nothing in the
/// workspace writes that event). `UserDeleted` is the real type the adapter
/// encodes.
mod pre_3_1b_encoders {
    #[derive(serde::Serialize)]
    pub struct VotePayload {
        pub post_id: String,
        pub thread_id: String,
        pub channel_id: String,
        pub direction: String,
        pub actor_user_id: u64,
    }

    #[derive(serde::Serialize)]
    pub struct SolutionPayload {
        pub post_id: String,
        pub thread_id: String,
        pub channel_id: String,
        pub actor_user_id: u64,
    }

    #[derive(serde::Serialize)]
    pub struct ConsumedPayload {
        pub user_id: u64,
        pub device_id: String,
        pub prekey_public: String,
    }
}

#[test]
fn golden_forum_vote_payload() {
    let encoded = postcard::to_allocvec(&pre_3_1b_encoders::VotePayload {
        post_id: "post_1".into(),
        thread_id: "thr_1".into(),
        channel_id: "ch_forum".into(),
        direction: "up".into(),
        actor_user_id: 4_200_000_001,
    })
    .unwrap();
    assert_eq!(hex::encode(&encoded), FORUM_VOTE_LEGACY);
    converted(FORUM_VOTE_LEGACY, b"FVOT", &forum_vote(), forum::encode_vote, forum::decode_vote);
}

pub(crate) fn forum_vote() -> forum::VotePayload {
    forum::VotePayload {
        post_id: "post_1".into(),
        thread_id: "thr_1".into(),
        channel_id: "ch_forum".into(),
        direction: "up".into(),
        actor_user_id: 4_200_000_001,
    }
}

#[test]
fn golden_forum_solution_payload() {
    let encoded = postcard::to_allocvec(&pre_3_1b_encoders::SolutionPayload {
        post_id: "post_1".into(),
        thread_id: "thr_1".into(),
        channel_id: "ch_forum".into(),
        actor_user_id: 4_200_000_001,
    })
    .unwrap();
    assert_eq!(hex::encode(&encoded), FORUM_SOLUTION_LEGACY);
    // The single struct that replaced the adapter's copy writes the same bytes.
    assert_eq!(hex::encode(forum::encode_solution(&forum_solution())), FORUM_SOLUTION_LEGACY);
    assert_eq!(forum::decode_solution(&bytes(FORUM_SOLUTION_LEGACY)).unwrap(), forum_solution());
}

pub(crate) fn forum_solution() -> forum::SolutionPayload {
    forum::SolutionPayload {
        post_id: "post_1".into(),
        thread_id: "thr_1".into(),
        channel_id: "ch_forum".into(),
        actor_user_id: 4_200_000_001,
    }
}

#[test]
fn golden_user_deleted() {
    let encoded =
        postcard::to_allocvec(&crate::domain::UserDeleted { user_id: 4_200_000_001 }).unwrap();
    assert_eq!(hex::encode(&encoded), USER_DELETED_LEGACY);
    // Decoded by the handler, which removes the sample member (that user id).
    use crate::engine::locks::ProjectionState;
    use crate::projections::handler::{DurableEvent, Projection};
    let state = ProjectionState::new();
    let member = channel_member();
    state.insert(
        "channel_members",
        channel_members::encode_key(&member.channel_id, member.user_id),
        channel_members::encode_record(&member),
        1,
    );
    let event = DurableEvent {
        commit_seq: 2,
        stream_id: "users".into(),
        event_type: "user_deleted".into(),
        payload: bytes(USER_DELETED_LEGACY),
    };
    crate::projections::user_deletion::UserDeletionProjection.apply(&event, &state).unwrap();
    assert!(channel_members::ChannelMembersProjection::list_members(&state, "ch_general")
        .unwrap()
        .is_empty());
}

#[test]
fn golden_dm_prekey_consumed_payload() {
    let encoded = postcard::to_allocvec(&pre_3_1b_encoders::ConsumedPayload {
        user_id: 9,
        device_id: "dev-phone".into(),
        prekey_public: "otk1".into(),
    })
    .unwrap();
    assert_eq!(hex::encode(&encoded), DM_PREKEY_CONSUMED_LEGACY);
    // The handler's decoder is private to its match arm; applying the event
    // to the sample identity is the only way to run it.
    use crate::engine::locks::ProjectionState;
    use crate::projections::handler::{DurableEvent, Projection};
    let state = ProjectionState::new();
    let identity = dm_identity();
    state.insert(
        "dm_identities",
        dm_identities::encode_key(identity.user_id, &identity.device_id),
        dm_identities::encode_record(&identity),
        1,
    );
    let event = DurableEvent {
        commit_seq: 2,
        stream_id: "dm_identities:9".into(),
        event_type: "dm_onetime_prekey_consumed".into(),
        payload: bytes(DM_PREKEY_CONSUMED_LEGACY),
    };
    dm_identities::DmIdentitiesProjection.apply(&event, &state).unwrap();
    let after = dm_identities::DmIdentitiesProjection::get_identity(&state, 9, "dev-phone")
        .unwrap()
        .unwrap();
    assert_eq!(after.one_time_prekeys, vec!["otk2".to_string()]);
}
