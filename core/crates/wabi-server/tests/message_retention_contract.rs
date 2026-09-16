//! Logical deletion is not secure erasure. Only disposable state is used.
use std::path::Path;
use wabi_server::adapter::WdbAdapter;
use wabidb::{domain::ChannelKind, engine::wabi_store::WabiStore};
use wabidb::projections::messages::{FileAttachmentRecord, MessagesProjection};

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() { copy_tree(&entry.path(), &target); }
        else { std::fs::copy(entry.path(), target).unwrap(); }
    }
}

#[tokio::test]
async fn deleted_canary_stays_hidden_after_restart_but_record_attachment_and_backup_remain() {
    let live = tempfile::tempdir().unwrap();
    let backup = tempfile::tempdir().unwrap();
    let attachment = live.path().join("uploads/canary.txt");
    std::fs::create_dir_all(attachment.parent().unwrap()).unwrap();
    std::fs::write(&attachment, b"attachment-retention-canary").unwrap();
    let store = WdbAdapter::open(live.path()).await.unwrap();
    let channel = store.create_channel("retention", ChannelKind::Text, 1, false).await.unwrap();
    let message = store.send_message(&channel, 1, "body-retention-canary", false, &[
        FileAttachmentRecord { file_url: "/uploads/canary.txt".into(), file_name: "canary.txt".into(), file_size: 27 },
    ]).await.unwrap();
    let retained = store.send_message(&channel, 1, "unrelated-visible-canary", false, &[]).await.unwrap();
    let cutoff = store.get_message_typed(&message).await.unwrap().unwrap().created_at_micros;
    assert!(MessagesProjection::list_messages_expired(&store.engine().projection_state(), &channel, cutoff, 1000)
        .unwrap().iter().any(|record| record.message_id == message));
    drop(store);
    copy_tree(live.path(), backup.path()); // Stopped consistent backup before deletion.

    let store = WdbAdapter::open(live.path()).await.unwrap();
    store.delete_message(&message, 1).await.unwrap();
    assert!(!store.list_messages_typed(&channel, 100).await.unwrap().iter().any(|m| m.message_id == message));
    assert!(!MessagesProjection::list_messages_expired(&store.engine().projection_state(), &channel, cutoff, 1000)
        .unwrap().iter().any(|record| record.message_id == message));
    drop(store);

    let reopened = WdbAdapter::open(live.path()).await.unwrap();
    let visible = reopened.list_messages_typed(&channel, 100).await.unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].message_id, retained);
    let deleted = reopened.get_message_typed(&message).await.unwrap().unwrap();
    assert!(deleted.is_deleted);
    assert_eq!(deleted.content, "body-retention-canary");
    assert_eq!(std::fs::read(attachment).unwrap(), b"attachment-retention-canary");
    drop(reopened);

    let restored = WdbAdapter::open(backup.path()).await.unwrap();
    assert!(restored.list_messages_typed(&channel, 100).await.unwrap().iter()
        .any(|m| m.message_id == message && m.content == "body-retention-canary"));
}
