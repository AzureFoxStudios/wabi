//! Checks against the REAL `lore` program. Never run in CI.
//!
//! Every other Lore test in this repository runs against a shell stand-in
//! that prints fixed answers and keeps no branches or commits. These checks
//! drive `LoreService` against the real program, in a temporary directory, to
//! answer questions the stand-in cannot. See
//! `docs/testing/LORE_REAL_BINARY_CHECKS.md` for what each one is for.
//!
//! They were written without access to the real program and had not been run
//! against it when they were added. A failure is a finding to investigate,
//! not something to weaken until it passes.
//!
//! Run:
//!
//! ```text
//! WABI_LORE_REAL_BINARY=/path/to/lore \
//!   cargo test -p wabi-lore --test real_lore_binary -- --ignored --nocapture --test-threads=1
//! ```
//!
//! Lines starting with `OBSERVED` are the answers. Nothing here touches a
//! real Wabi data directory.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use wabi_lore::{LoreConfig, LoreRepoSeed, LoreService};

const CHANNEL: i64 = 4242;
const AUTHOR: i64 = 7;

fn real_binary() -> PathBuf {
    let path = std::env::var_os("WABI_LORE_REAL_BINARY").expect(
        "set WABI_LORE_REAL_BINARY to the real lore program; these checks do not run against a stand-in",
    );
    let path = PathBuf::from(path);
    assert!(path.exists(), "WABI_LORE_REAL_BINARY does not exist: {}", path.display());
    path
}

fn config(data_dir: &Path) -> LoreConfig {
    LoreConfig {
        enabled: true,
        lore_binary_path: real_binary(),
        lore_data_dir: data_dir.to_path_buf(),
        ..Default::default()
    }
}

struct Repo {
    dir: tempfile::TempDir,
    service: Arc<LoreService>,
    tree: PathBuf,
}

impl Repo {
    /// A new repository holding `a.txt` = "v1", committed directly.
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let service = Arc::new(LoreService::new(config(&dir.path().join("lore"))));
        service
            .create_repo(CHANNEL, AUTHOR, "real-binary-check")
            .await
            .expect("create_repo against the real lore program");
        let tree = service.repo_working_tree(CHANNEL).await.unwrap();
        let repo = Self { dir, service, tree };
        repo.upload("a.txt", b"v1", "first file")
            .await
            .expect("first direct upload");
        repo
    }

    fn source(&self, bytes: &[u8]) -> PathBuf {
        let path = self.dir.path().join(format!("src-{}", uuid::Uuid::new_v4().simple()));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    async fn upload(
        &self,
        repo_path: &str,
        bytes: &[u8],
        message: &str,
    ) -> anyhow::Result<wabi_lore::LoreUploadResult> {
        let source = self.source(bytes);
        self.service
            .upload_file(CHANNEL, source.to_str().unwrap(), repo_path, message, AUTHOR)
            .await
    }

    async fn promote(
        &self,
        repo_path: &str,
        bytes: &[u8],
        branch: &str,
        review_branch: Option<&str>,
    ) -> anyhow::Result<wabi_lore::LoreUploadResult> {
        let source = self.source(bytes);
        self.service
            .promote_file(
                CHANNEL,
                source.to_str().unwrap(),
                repo_path,
                "promote check",
                AUTHOR,
                branch,
                review_branch,
            )
            .await
    }

    fn read(&self, repo_path: &str) -> Option<Vec<u8>> {
        std::fs::read(self.tree.join(repo_path)).ok()
    }

    async fn branches(&self) -> Vec<String> {
        self.service
            .list_branches(CHANNEL)
            .await
            .expect("list_branches")
            .into_iter()
            .map(|b| if b.is_current { format!("*{}", b.name) } else { b.name })
            .collect()
    }

    async fn current_branch(&self) -> String {
        self.service
            .list_branches(CHANNEL)
            .await
            .expect("list_branches")
            .into_iter()
            .find(|b| b.is_current)
            .map(|b| b.name)
            .expect("the real program must report a current branch")
    }

    async fn status(&self) -> String {
        match self.service.status(CHANNEL).await {
            Ok(text) => text,
            Err(error) => format!("status failed: {error}"),
        }
    }
}

/// Q3. What does a new repository call its first branch? The promote handler
/// and `set_binding` default to the literal `main`.
#[tokio::test]
#[ignore = "needs the real lore program: set WABI_LORE_REAL_BINARY"]
async fn q3_first_branch_name_and_direct_promote_to_main() {
    let repo = Repo::new().await;
    let first = repo.current_branch().await;
    println!("OBSERVED q3: first branch of a new repository is {first:?}");
    println!("OBSERVED q3: branch list {:?}", repo.branches().await);

    // What the handler does when no branch is given: a direct promote to "main".
    let result = repo.promote("direct.txt", b"direct", "main", None).await;
    match &result {
        Ok(done) => println!(
            "OBSERVED q3: direct promote to \"main\" succeeded (pending_review={}, branch now {:?})",
            done.pending_review,
            repo.current_branch().await
        ),
        Err(error) => println!("OBSERVED q3: direct promote to \"main\" FAILED: {error:#}"),
    }
    assert_eq!(
        first, "main",
        "the default branch literal in api/lore.rs is \"main\"; a different first branch makes a default promote fail"
    );
    result.expect("a direct promote to the default branch must work");
    assert_eq!(repo.read("direct.txt").as_deref(), Some(&b"direct"[..]));
    assert_eq!(repo.current_branch().await, first);
}

/// Q1. An upload that goes to a review branch must leave the mainline's files
/// and branch exactly as they were. This is what Task 4.1 and Task 4.8b rely
/// on for members without `lore.commit`.
#[tokio::test]
#[ignore = "needs the real lore program: set WABI_LORE_REAL_BINARY"]
async fn q1_review_branch_upload_leaves_the_mainline_untouched() {
    let repo = Repo::new().await;
    let mainline = repo.current_branch().await;

    // Change an existing file on a review branch.
    let changed = repo
        .promote("a.txt", b"v2 for review", "", Some("uploads/check-change"))
        .await
        .expect("review-branch promote of an existing file");
    println!(
        "OBSERVED q1: changed file: pending_review={} review_branch={:?} revision={}",
        changed.pending_review, changed.review_branch, changed.revision.hash
    );
    println!("OBSERVED q1: branches after {:?}", repo.branches().await);
    println!(
        "OBSERVED q1: mainline a.txt is {:?}",
        repo.read("a.txt").map(|b| String::from_utf8_lossy(&b).into_owned())
    );
    assert!(changed.pending_review);
    assert_eq!(changed.review_branch.as_deref(), Some("uploads/check-change"));
    assert_eq!(repo.current_branch().await, mainline, "working tree left on the review branch");
    assert_eq!(
        repo.read("a.txt").as_deref(),
        Some(&b"v1"[..]),
        "the review upload changed the mainline's working tree"
    );

    // Add a new file on a review branch.
    repo.promote("new.txt", b"new for review", "", Some("uploads/check-new"))
        .await
        .expect("review-branch promote of a new file");
    println!("OBSERVED q1: mainline has new.txt: {}", repo.read("new.txt").is_some());
    println!("OBSERVED q1: status after both\n{}", repo.status().await);
    assert_eq!(repo.current_branch().await, mainline);
    assert!(
        repo.read("new.txt").is_none(),
        "a file uploaded for review is present in the mainline's working tree"
    );

    // A later direct commit on the mainline must not carry the review bytes.
    repo.upload("b.txt", b"direct", "direct after reviews")
        .await
        .expect("direct upload after review uploads");
    assert_eq!(repo.read("a.txt").as_deref(), Some(&b"v1"[..]));
    assert!(repo.read("new.txt").is_none());
    assert_eq!(repo.current_branch().await, mainline);
}

/// Approving a review branch puts its bytes on the mainline. Never checked
/// against the real program before.
#[tokio::test]
#[ignore = "needs the real lore program: set WABI_LORE_REAL_BINARY"]
async fn approving_a_review_branch_lands_its_bytes_on_the_mainline() {
    let repo = Repo::new().await;
    let mainline = repo.current_branch().await;
    repo.promote("a.txt", b"v2 approved", "", Some("uploads/check-approve"))
        .await
        .expect("review-branch promote");
    assert_eq!(repo.read("a.txt").as_deref(), Some(&b"v1"[..]));

    let approved = repo.service.approve_review_branch(CHANNEL, "uploads/check-approve").await;
    match &approved {
        Ok(revision) => println!("OBSERVED approve: merged as revision {}", revision.hash),
        Err(error) => println!("OBSERVED approve: FAILED: {error:#}"),
    }
    println!("OBSERVED approve: branches after {:?}", repo.branches().await);
    approved.expect("approve_review_branch");
    assert_eq!(repo.current_branch().await, mainline);
    assert_eq!(repo.read("a.txt").as_deref(), Some(&b"v2 approved"[..]));
}

/// Q2. Does a staged, uncommitted file follow a branch switch? If it does, a
/// promote that fails after staging leaves that file on the mainline, and a
/// retry reports a collision. Observation only: the right behaviour is not
/// decided yet.
#[tokio::test]
#[ignore = "needs the real lore program: set WABI_LORE_REAL_BINARY"]
async fn q2_observe_a_staged_file_across_a_branch_switch() {
    let repo = Repo::new().await;
    let mainline = repo.current_branch().await;

    repo.service
        .create_branch(CHANNEL, "probe-staged", None)
        .await
        .expect("create_branch");
    repo.service
        .switch_branch(CHANNEL, "probe-staged")
        .await
        .expect("switch to the probe branch");
    let source = repo.source(b"staged, never committed");
    let staged = repo
        .service
        .stage_file(CHANNEL, source.to_str().unwrap(), "staged.txt")
        .await;
    println!("OBSERVED q2: stage on the probe branch: {:?}", staged.as_ref().map(|f| &f.path).map_err(|e| e.to_string()));
    println!("OBSERVED q2: status on the probe branch\n{}", repo.status().await);

    let back = repo.service.switch_branch(CHANNEL, &mainline).await;
    println!("OBSERVED q2: switch back to {mainline:?}: {:?}", back.as_ref().map_err(|e| e.to_string()));
    println!("OBSERVED q2: current branch {:?}", repo.current_branch().await);
    println!(
        "OBSERVED q2: staged.txt present in the tree after switching back: {}",
        repo.read("staged.txt").is_some()
    );
    println!("OBSERVED q2: status after switching back\n{}", repo.status().await);

    // The retry: the same path uploaded directly on the mainline.
    let retry = repo.upload("staged.txt", b"retry", "retry after a failed promote").await;
    println!(
        "OBSERVED q2: direct upload of the same path afterwards: {:?}",
        retry.as_ref().map(|r| r.revision.hash.clone()).map_err(|e| format!("{e:#}"))
    );

    // What a direct commit of another file does with the leftover.
    let other = repo.upload("other.txt", b"other", "unrelated direct commit").await;
    println!(
        "OBSERVED q2: unrelated direct upload afterwards: {:?}",
        other.as_ref().map(|r| r.revision.hash.clone()).map_err(|e| format!("{e:#}"))
    );
    println!("OBSERVED q2: final status\n{}", repo.status().await);
}

/// Q5. If the server stops while the tree is on a review branch, nothing puts
/// it back at startup. Where does the next direct upload land? Observation
/// only: this is a known gap, and the check shows how the real program
/// behaves in it.
#[tokio::test]
#[ignore = "needs the real lore program: set WABI_LORE_REAL_BINARY"]
async fn q5_observe_a_restart_while_on_a_review_branch() {
    let repo = Repo::new().await;
    let mainline = repo.current_branch().await;
    repo.service
        .create_branch(CHANNEL, "uploads/left-behind", None)
        .await
        .expect("create_branch");
    repo.service
        .switch_branch(CHANNEL, "uploads/left-behind")
        .await
        .expect("switch_branch");

    // "Restart": a new service over the same data directory.
    let restarted = LoreService::new(config(&repo.dir.path().join("lore")));
    restarted
        .load_existing_repos(vec![LoreRepoSeed {
            channel_id: CHANNEL,
            repo_name: "real-binary-check".into(),
            lore_server_url: String::new(),
            created_by: AUTHOR,
            created_at_micros: 0,
        }])
        .await;
    let current = restarted
        .list_branches(CHANNEL)
        .await
        .map(|all| all.into_iter().find(|b| b.is_current).map(|b| b.name));
    println!("OBSERVED q5: current branch after restart: {:?}", current.map_err(|e| format!("{e:#}")));

    let source = repo.source(b"uploaded after restart");
    let upload = restarted
        .upload_file(CHANNEL, source.to_str().unwrap(), "after-restart.txt", "direct upload", AUTHOR)
        .await;
    println!(
        "OBSERVED q5: direct upload after restart: {:?}",
        upload.as_ref().map(|r| (r.pending_review, r.revision.hash.clone())).map_err(|e| format!("{e:#}"))
    );
    let back = restarted.switch_branch(CHANNEL, &mainline).await;
    println!("OBSERVED q5: switch back to {mainline:?}: {:?}", back.map_err(|e| format!("{e:#}")));
    println!(
        "OBSERVED q5: after-restart.txt is on the mainline: {} (false means the upload landed on the left-behind branch)",
        repo.read("after-restart.txt").is_some()
    );
}

/// Q6. Someone with `lore.commit` has staged a batch on the mainline and not
/// sealed it yet. A member without `lore.commit` then uploads, which goes to a
/// review branch. Does the real program sweep the staged file into the review
/// commit, refuse the branch switch, or keep the two apart? Observation only.
#[tokio::test]
#[ignore = "needs the real lore program: set WABI_LORE_REAL_BINARY"]
async fn q6_observe_a_review_upload_during_a_staged_batch() {
    let repo = Repo::new().await;
    let mainline = repo.current_branch().await;
    let source = repo.source(b"batch file, staged and not sealed");
    repo.service
        .stage_file(CHANNEL, source.to_str().unwrap(), "batch-a.txt")
        .await
        .expect("stage_file on the mainline");
    println!("OBSERVED q6: status with the batch staged\n{}", repo.status().await);

    let review = repo.promote("b.txt", b"for review", "", Some("uploads/check-batch")).await;
    println!(
        "OBSERVED q6: review upload during the batch: {:?}",
        review.as_ref().map(|r| (r.pending_review, r.revision.hash.clone())).map_err(|e| format!("{e:#}"))
    );
    println!("OBSERVED q6: current branch afterwards {:?} (mainline is {mainline:?})", repo.current_branch().await);
    println!(
        "OBSERVED q6: in the tree afterwards: batch-a.txt={} b.txt={}",
        repo.read("batch-a.txt").is_some(),
        repo.read("b.txt").is_some()
    );
    println!("OBSERVED q6: status afterwards\n{}", repo.status().await);

    // Seal the batch the way POST /snapshot does, and see what it holds.
    let sealed = repo.service.commit_staged(CHANNEL, "seal the batch", AUTHOR).await;
    println!(
        "OBSERVED q6: sealing the batch afterwards: {:?}",
        sealed.as_ref().map(|r| r.hash.clone()).map_err(|e| format!("{e:#}"))
    );
    println!(
        "OBSERVED q6: after sealing: batch-a.txt={} b.txt={} (b.txt on the mainline would mean the review bytes leaked)",
        repo.read("batch-a.txt").is_some(),
        repo.read("b.txt").is_some()
    );
}

/// Basic operations the stand-in only pretends to do: delete, a second
/// revision of one path, and the health check.
#[tokio::test]
#[ignore = "needs the real lore program: set WABI_LORE_REAL_BINARY"]
async fn basic_direct_operations_work() {
    let repo = Repo::new().await;
    let health = repo.service.health_check().await;
    println!("OBSERVED basic: health_check: {:?}", health.as_ref().map_err(|e| format!("{e:#}")));

    let first = repo.upload("notes/n.txt", b"one", "one").await.expect("upload one");
    let second = repo.upload("notes/n.txt", b"two", "two").await.expect("upload two");
    println!(
        "OBSERVED basic: revisions {} then {} (numbers {} and {})",
        first.revision.hash, second.revision.hash, first.revision.revision_number, second.revision.revision_number
    );
    assert_ne!(first.revision.hash, second.revision.hash);
    assert_eq!(repo.read("notes/n.txt").as_deref(), Some(&b"two"[..]));

    // The same bytes again: does the real program refuse an empty commit?
    let same = repo.upload("notes/n.txt", b"two", "same bytes").await;
    println!(
        "OBSERVED basic: uploading identical bytes again: {:?}",
        same.as_ref().map(|r| r.revision.hash.clone()).map_err(|e| format!("{e:#}"))
    );

    repo.service
        .delete_file(CHANNEL, "notes/n.txt", "delete check")
        .await
        .expect("delete_file");
    assert!(repo.read("notes/n.txt").is_none(), "deleted file is still in the working tree");
    println!("OBSERVED basic: status at the end\n{}", repo.status().await);
}
