//! Files over the full-hash limit (4 MiB). Their etag is sampled and includes
//! the file's mtime, and the server computes it over its own copy, so the
//! local etag and the server's etag for the same bytes are never equal. These
//! tests run the engine against the in-process server from `review_tests`,
//! which hands back such a server-side etag.

use crate::config::{StateBeforeFingerprints, STATE_DIR};
use crate::etag::ETAG_FULL_HASH_MAX_BYTES;
use crate::review_tests::Harness;

const BIG: &str = "big.bin";

/// Just over the limit; `fill` makes two versions differ in every byte.
fn big(fill: u8) -> Vec<u8> {
    vec![fill; ETAG_FULL_HASH_MAX_BYTES as usize + 1]
}

fn write_big(h: &Harness, fill: u8) {
    std::fs::write(h.folder().join(BIG), big(fill)).unwrap();
}

fn read_big(h: &Harness) -> Vec<u8> {
    std::fs::read(h.folder().join(BIG)).unwrap()
}

fn puts(h: &Harness) -> usize {
    h.server(|f| f.puts.len())
}

/// A linked folder whose `big.bin` was uploaded to the mainline once.
async fn with_uploaded_big() -> Harness {
    let h = Harness::start().await;
    write_big(&h, 1);
    let first = h.sync().await.unwrap();
    assert_eq!(first.uploaded, vec![BIG]);
    assert_eq!(puts(&h), 1);
    h
}

/// Consequence 1: after a successful upload, the unchanged file must not be
/// uploaded again on the next round.
#[tokio::test]
async fn unchanged_large_file_is_not_uploaded_again() {
    let h = with_uploaded_big().await;

    let second = h.sync().await.unwrap();
    assert_eq!(puts(&h), 1, "uploaded again although unchanged");
    assert!(second.is_empty());
    let third = h.sync().await.unwrap();
    assert_eq!(puts(&h), 1);
    assert!(third.is_empty());
    assert!(h.conflict_copies().is_empty());
}

/// Consequence 2: a large file that was just downloaded is neither uploaded
/// back nor downloaded again.
#[tokio::test]
async fn downloaded_large_file_is_not_uploaded_back() {
    let h = Harness::start().await;
    h.server(|f| f.set_mainline(BIG, big(1)));

    let first = h.sync().await.unwrap();
    assert_eq!(first.downloaded, vec![BIG]);
    assert_eq!(read_big(&h), big(1));

    let second = h.sync().await.unwrap();
    assert_eq!(puts(&h), 0, "downloaded file was uploaded back");
    assert!(second.is_empty(), "second round was not quiet");
    assert!(h.conflict_copies().is_empty());
}

/// Consequence 3: the mainline changed a large file the user did not touch.
/// The local copy is clean and is updated, with no conflict copy.
#[tokio::test]
async fn mainline_change_to_untouched_large_file_updates_it() {
    let h = with_uploaded_big().await;
    h.server(|f| f.set_mainline(BIG, big(2)));

    let report = h.sync().await.unwrap();
    assert!(report.conflicts.is_empty(), "{:?}", report.conflicts);
    assert!(h.conflict_copies().is_empty(), "{:?}", h.conflict_copies());
    assert_eq!(report.downloaded, vec![BIG]);
    assert_eq!(read_big(&h), big(2));
    assert_eq!(puts(&h), 1, "nothing was edited locally");

    // Same for a copy that arrived by download rather than upload.
    h.server(|f| f.set_mainline(BIG, big(3)));
    let report = h.sync().await.unwrap();
    assert!(report.conflicts.is_empty(), "{:?}", report.conflicts);
    assert_eq!(report.downloaded, vec![BIG]);
    assert_eq!(read_big(&h), big(3));

    let quiet = h.sync().await.unwrap();
    assert!(quiet.is_empty());
    assert_eq!(puts(&h), 1);
}

/// A large file edited locally is uploaded, with If-Match carrying the
/// server's etag (the fake answers 409 for anything else).
#[tokio::test]
async fn edited_large_file_is_uploaded() {
    let h = with_uploaded_big().await;
    write_big(&h, 2);

    let report = h.sync().await.unwrap();
    assert_eq!(report.uploaded, vec![BIG]);
    assert!(report.conflicts.is_empty(), "{:?}", report.conflicts);
    assert_eq!(puts(&h), 2);
    assert_eq!(h.server(|f| f.mainline.get(BIG).cloned()), Some(big(2)));

    let quiet = h.sync().await.unwrap();
    assert!(quiet.is_empty());
    assert_eq!(puts(&h), 2);
}

/// An edit that changes neither the size nor the sampled head and tail is
/// still seen, through the mtime.
#[tokio::test]
async fn large_file_edited_in_the_middle_is_uploaded() {
    let h = with_uploaded_big().await;
    let mut bytes = big(1);
    let middle = bytes.len() / 2;
    bytes[middle] = 9;
    std::fs::write(h.folder().join(BIG), &bytes).unwrap();
    // Do not depend on the filesystem's timestamp resolution.
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
    std::fs::File::options()
        .write(true)
        .open(h.folder().join(BIG))
        .unwrap()
        .set_modified(later)
        .unwrap();

    let report = h.sync().await.unwrap();
    assert_eq!(report.uploaded, vec![BIG]);
    assert_eq!(h.server(|f| f.mainline.get(BIG).cloned()), Some(bytes));
}

/// A new large file whose upload answered pendingReview is uploaded once, not
/// once per round (each upload would open another review branch).
#[tokio::test]
async fn new_large_file_waiting_for_review_is_not_uploaded_again() {
    let h = Harness::start().await;
    h.server(|f| f.route_to_review = true);
    write_big(&h, 1);

    let first = h.sync().await.unwrap();
    assert_eq!(first.uploaded, vec![BIG]);
    assert_eq!(first.waiting_review, vec![BIG]);

    let second = h.sync().await.unwrap();
    assert_eq!(puts(&h), 1, "uploaded to review again although unchanged");
    assert!(second.uploaded.is_empty());
    assert_eq!(second.waiting_review, vec![BIG]);
    assert_eq!(read_big(&h), big(1));
}

/// The same for an edit of a large file that is already on the mainline, and
/// the edit is uploaded again only when it changes again.
#[tokio::test]
async fn large_edit_waiting_for_review_is_not_uploaded_again() {
    let h = with_uploaded_big().await;
    h.server(|f| f.route_to_review = true);
    write_big(&h, 2);

    h.sync().await.unwrap();
    assert_eq!(puts(&h), 2);
    let second = h.sync().await.unwrap();
    assert_eq!(puts(&h), 2, "uploaded to review again although unchanged");
    assert!(second.uploaded.is_empty());
    assert_eq!(second.waiting_review, vec![BIG]);
    assert!(second.downloaded.is_empty());
    assert!(h.conflict_copies().is_empty());
    assert_eq!(read_big(&h), big(2), "the edit stays on disk");

    write_big(&h, 3);
    let third = h.sync().await.unwrap();
    assert_eq!(third.uploaded, vec![BIG]);
    assert_eq!(puts(&h), 3);
    assert_eq!(h.server(|f| f.review.get(BIG).cloned()), Some(big(3)));
}

/// Someone else changed the mainline while a large edit waited for review:
/// the local edit is not a clean copy and survives as a conflict copy.
#[tokio::test]
async fn mainline_change_while_large_edit_is_pending_keeps_the_edit() {
    let h = with_uploaded_big().await;
    h.server(|f| f.route_to_review = true);
    write_big(&h, 2);
    h.sync().await.unwrap();
    h.server(|f| f.set_mainline(BIG, big(3)));

    let report = h.sync().await.unwrap();
    assert_eq!(report.conflicts.len(), 1, "{:?}", report.conflicts);
    assert_eq!(read_big(&h), big(3));
    let copies = h.conflict_copies();
    assert_eq!(copies.len(), 1);
    assert_eq!(std::fs::read(h.folder().join(&copies[0])).unwrap(), big(2), "local work survives");
    assert_eq!(puts(&h), 2, "no silent re-upload over the mainline");
    assert!(h.state().pending_review.is_empty());
}

/// A large file deleted on the mainline and untouched locally is deleted
/// locally; one edited locally is kept as a conflict copy.
#[tokio::test]
async fn mainline_delete_of_a_large_file() {
    let h = with_uploaded_big().await;
    h.server(|f| f.mainline.remove(BIG));
    let report = h.sync().await.unwrap();
    assert_eq!(report.deleted_local, vec![BIG]);
    assert!(report.conflicts.is_empty(), "{:?}", report.conflicts);
    assert!(!h.folder().join(BIG).exists());
    assert!(h.state().local_fingerprints.is_empty());

    let h = with_uploaded_big().await;
    write_big(&h, 2);
    h.server(|f| f.mainline.remove(BIG));
    // Pull only: a full round would first upload the edit (409, conflict).
    let mut engine = crate::sync::SyncEngine::new(&h.client, h.folder(), &h.link);
    let report = engine.pull().await.unwrap();
    assert!(report.deleted_local.is_empty());
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(h.conflict_copies().len(), 1);
}

/// A large file deleted locally is deleted on the server, If-Match carrying
/// the server's etag, and its fingerprint goes with it.
#[tokio::test]
async fn local_delete_of_a_large_file_is_pushed() {
    let h = with_uploaded_big().await;
    std::fs::remove_file(h.folder().join(BIG)).unwrap();

    let report = h.sync().await.unwrap();
    assert_eq!(report.deleted_remote, vec![BIG]);
    assert_eq!(h.server(|f| f.deletes.clone()), vec![BIG]);
    assert!(h.state().local_fingerprints.is_empty());
}

// -- State file ---------------------------------------------------------------

fn state_path(h: &Harness) -> std::path::PathBuf {
    h.folder().join(STATE_DIR).join("state.json")
}

/// The state holds the server's etag as the baseline and the local etag next
/// to it; a folder with only small files writes no fingerprints at all.
#[tokio::test]
async fn fingerprint_is_recorded_only_where_the_etags_differ() {
    let h = with_uploaded_big().await;
    std::fs::write(h.folder().join("small.txt"), b"small").unwrap();
    h.sync().await.unwrap();

    let state = h.state();
    let baseline = state.baselines.get(BIG).cloned().flatten().unwrap();
    assert!(baseline.starts_with("q-server-"), "baseline is the server's etag: {baseline}");
    let local = crate::etag::etag_for_file(&h.folder().join(BIG)).unwrap();
    assert_eq!(state.local_fingerprints.get(BIG), Some(&local));
    assert_ne!(local, baseline);
    assert!(!state.local_fingerprints.contains_key("small.txt"));

    let small_only = Harness::start().await;
    std::fs::write(small_only.folder().join("small.txt"), b"small").unwrap();
    small_only.sync().await.unwrap();
    let raw = std::fs::read_to_string(state_path(&small_only)).unwrap();
    assert!(!raw.contains("local_fingerprints"), "{raw}");
}

/// A state file from an older build (or one an older build rewrote): the
/// large file has a baseline but no fingerprint. The first round behaves as
/// that build did (one upload, accepted because If-Match is the server's
/// etag); the upload fills the fingerprint in and the next round is quiet.
#[tokio::test]
async fn state_from_an_older_build_is_filled_in_on_the_next_sync() {
    let h = with_uploaded_big().await;
    let raw = std::fs::read_to_string(state_path(&h)).unwrap();
    let old: StateBeforeFingerprints = serde_json::from_str(&raw).unwrap();
    assert_eq!(old.baselines, h.state().baselines);
    std::fs::write(state_path(&h), serde_json::to_string_pretty(&old).unwrap()).unwrap();
    assert!(h.state().local_fingerprints.is_empty());

    let first = h.sync().await.unwrap();
    assert_eq!(first.uploaded, vec![BIG], "unknown fingerprint: today's comparison");
    assert!(first.conflicts.is_empty(), "{:?}", first.conflicts);
    assert_eq!(puts(&h), 2);
    assert!(h.state().local_fingerprints.contains_key(BIG));

    let second = h.sync().await.unwrap();
    assert!(second.is_empty());
    assert_eq!(puts(&h), 2);
    assert!(h.conflict_copies().is_empty());
}

/// A linked folder whose edit of `big.bin` (1 → 2) is waiting for review.
async fn with_pending_big_edit() -> Harness {
    let h = with_uploaded_big().await;
    h.server(|f| f.route_to_review = true);
    write_big(&h, 2);
    let report = h.sync().await.unwrap();
    assert_eq!(report.waiting_review, vec![BIG]);
    h
}

/// A large edit is waiting for review, the mainline changes, and the round
/// that finds the conflict fails while fetching the mainline's version. The
/// edit must survive the next round, in a conflict copy.
#[tokio::test]
async fn failed_conflict_round_does_not_lose_a_large_pending_edit() {
    let h = with_pending_big_edit().await;
    h.server(|f| {
        f.set_mainline(BIG, big(3));
        f.fail_downloads = 1;
    });
    assert!(h.sync().await.is_err(), "the injected failure");
    assert_eq!(read_big(&h), big(2), "the failed round touched the file");

    let report = h.sync().await.unwrap();
    assert_eq!(report.conflicts.len(), 1, "{:?} / downloaded {:?}", report.conflicts, report.downloaded);
    assert_eq!(read_big(&h), big(3));
    let copies = h.conflict_copies();
    assert_eq!(copies.len(), 1, "the edit is gone: {copies:?}");
    assert_eq!(std::fs::read(h.folder().join(&copies[0])).unwrap(), big(2));
}

/// A large review upload is approved: the mainline holds the same bytes under
/// an etag the client could not predict. That is not a conflict.
#[tokio::test]
async fn approved_large_review_upload_makes_no_conflict_copy() {
    let h = with_pending_big_edit().await;
    h.server(|f| f.set_mainline(BIG, big(2)));

    let report = h.sync().await.unwrap();
    assert!(report.conflicts.is_empty(), "{:?}", report.conflicts);
    assert!(h.conflict_copies().is_empty(), "{:?}", h.conflict_copies());
    assert_eq!(read_big(&h), big(2));
    assert!(h.state().pending_review.is_empty());
    assert!(h.sync().await.unwrap().is_empty());
    assert_eq!(puts(&h), 2, "uploaded again");
}
