//! Files over the full-hash limit (4 MiB). Their etag is sampled and includes
//! the file's mtime, and the server computes it over its own copy, so the
//! local etag and the server's etag for the same bytes are never equal. These
//! tests run the engine against the in-process server from `review_tests`,
//! which hands back such a server-side etag.

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
