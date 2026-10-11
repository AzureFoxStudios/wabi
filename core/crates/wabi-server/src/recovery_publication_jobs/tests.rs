use super::*;

#[test]
fn original_capture_mapping_is_exact_canonical_and_never_allocates_retry_identity() {
    let id = "00112233-4455-6677-8899-aabbccddeeff";
    let first = operation_id(id).unwrap();
    assert_eq!(first, "00112233445566778899aabbccddeeff");
    assert_eq!(operation_id(id).unwrap(), first);
    assert_eq!(uuid::Uuid::parse_str(&first).unwrap().to_string(), id);
    for invalid in ["../capture", "00112233445566778899aabbccddeeff",
        "00112233-4455-6677-8899-AABBCCDDEEFF", ""] {
        assert!(operation_id(invalid).is_err());
    }
}

#[test]
fn deadline_never_renews_after_expiry() {
    assert!(remaining(Instant::now() - Duration::from_millis(1)).is_err());
    assert!(remaining(Instant::now() + Duration::from_secs(1)).is_ok());
}

#[test]
fn durable_original_stage_selects_resume_without_reoffering_capture_or_new_identity() {
    let original = "00112233445566778899aabbccddeeff";
    assert_eq!(original_action(original, &[]).unwrap(), OriginalAction::Capture);
    for (stage, expected) in [
        (PublicationStage::Capture, OriginalAction::Capture),
        (PublicationStage::Manifest, OriginalAction::Resume),
        (PublicationStage::Prepared, OriginalAction::Resume),
    ] {
        let records = [PublicationOperation { operation_id: original.into(), stage }];
        assert_eq!(original_action(original, &records).unwrap(), expected);
        assert_eq!(records[0].operation_id, original);
    }
    let duplicate = [
        PublicationOperation { operation_id: original.into(), stage: PublicationStage::Capture },
        PublicationOperation { operation_id: original.into(), stage: PublicationStage::Prepared },
    ];
    assert!(original_action(original, &duplicate).is_err());
    let excessive: Vec<_> = (0..=HISTORY).map(|_| PublicationOperation {
        operation_id: original.into(), stage: PublicationStage::Capture,
    }).collect();
    assert!(original_action(original, &excessive).is_err());
    assert!(original_action("00112233-4455-6677-8899-aabbccddeeff", &[]).is_err());
    assert!(original_action("00112233445566778899AABBCCDDEEFF", &[]).is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_shutdown_waiter_retains_actual_handle_then_repeated_wait_observes_terminal() {
    // Real blocked task/handle; synthetic supervision seam, not a Wabi
    // runtime/Ready publication cancellation acceptance.
    let (entered, entered_rx) = oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let handle = tokio::spawn(async move {
        tokio::task::spawn_blocking(move || {
            entered.send(()).unwrap();
            released.recv().unwrap();
        }).await.unwrap();
        Ok(())
    });
    let owner = Arc::new(tokio::sync::Mutex::new(Supervision { handle: Some(handle), terminal: None }));
    entered_rx.await.unwrap();
    let waiting = owner.clone();
    let caller = tokio::spawn(async move { waiting.lock().await.drain().await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while owner.try_lock().is_ok() { tokio::task::yield_now().await; }
    }).await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    {
        let retained = owner.lock().await;
        assert!(retained.handle.as_ref().is_some_and(|handle| !handle.is_finished()));
        assert!(retained.terminal.is_none());
    }
    release.send(()).unwrap();
    let mut retained = owner.lock().await;
    retained.drain().await.unwrap();
    assert!(retained.handle.is_none());
    assert!(matches!(retained.terminal.as_ref(), Some(Ok(()))));
    retained.drain().await.unwrap();
}

#[tokio::test]
async fn failed_supervisor_result_remains_observable_on_repeated_shutdown() {
    let handle = tokio::spawn(async { Err(anyhow::anyhow!("deliberate supervision failure")) });
    let mut owner = Supervision { handle: Some(handle), terminal: None };
    let first = owner.drain().await.unwrap_err().to_string();
    let second = owner.drain().await.unwrap_err().to_string();
    assert_eq!(first, "deliberate supervision failure");
    assert_eq!(second, first);
    assert!(owner.handle.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn supervisor_waits_for_actual_initial_read_handle_even_without_publication_worker() {
    // Deliberate handle-lifetime seam, not an actual Ready read or publisher
    // acceptance. The real tracked handle owns a blocked blocking task.
    let (stop, stopped) = oneshot::channel();
    let (entered, entered_rx) = oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let reader = tokio::spawn(async move {
        tokio::task::spawn_blocking(move || {
            entered.send(()).unwrap();
            released.recv().unwrap();
            Err::<HeldReadyCapture, _>(anyhow::anyhow!("deliberate source refusal"))
        }).await.unwrap()
    });
    entered_rx.await.unwrap();
    let inner = Arc::new(Inner {
        community: "fixture".into(), source_node: "fixture".into(), collector_node: 1,
        restart: Mutex::new(RestartState::default()),
        budget: Duration::from_secs(1), closed: AtomicBool::new(false),
        stop: Mutex::new(Some(stop)), jobs: Mutex::new(Jobs::default()),
        runtime: tokio::sync::Mutex::new(None),
        initial_read: tokio::sync::Mutex::new(Some(reader)),
        final_read: tokio::sync::Mutex::new(None), ready: Mutex::new(None),
        authority: Mutex::new(None), _authority_storage: None,
    });
    inner.close();
    let drained = tokio::spawn(supervise(inner, stopped));
    tokio::task::yield_now().await;
    assert!(!drained.is_finished());
    release.send(()).unwrap();
    assert!(drained.await.unwrap().is_err());
}

#[test]
fn restart_identity_uses_only_the_original_canonical_journal_operation() {
    let operation = "00112233445566778899aabbccddeeff";
    let capture = original_capture(operation).unwrap();
    assert_eq!(capture, "00112233-4455-6677-8899-aabbccddeeff");
    assert_eq!(operation_id(&capture).unwrap(), operation);
    for invalid in [capture.as_str(), "00112233445566778899AABBCCDDEEFF", "../intent", ""] {
        assert!(original_capture(invalid).is_err());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_joins_the_original_restart_worker_before_releasing_owners() {
    // Real blocked owned task; a supervision seam, not genuine publication
    // or a process-kill/whole-instance failover acceptance result.
    let (stop, stopped) = oneshot::channel();
    let (entered, entered_rx) = oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let restart = tokio::spawn(async move {
        tokio::task::spawn_blocking(move || {
            entered.send(()).unwrap();
            released.recv().unwrap();
        }).await.unwrap();
        Ok(())
    });
    entered_rx.await.unwrap();
    let inner = Arc::new(Inner {
        community: "fixture".into(), source_node: "fixture".into(), collector_node: 1,
        restart: Mutex::new(RestartState { authority: None, worker: Some(restart) }),
        budget: Duration::from_secs(1), closed: AtomicBool::new(false),
        stop: Mutex::new(Some(stop)), jobs: Mutex::new(Jobs::default()),
        runtime: tokio::sync::Mutex::new(None), initial_read: tokio::sync::Mutex::new(None),
        final_read: tokio::sync::Mutex::new(None), ready: Mutex::new(None),
        authority: Mutex::new(None), _authority_storage: None,
    });
    inner.close();
    let drained = tokio::spawn(supervise(inner, stopped));
    tokio::task::yield_now().await;
    assert!(!drained.is_finished());
    release.send(()).unwrap();
    drained.await.unwrap().unwrap();
}

#[path = "genuine_restart_tests.rs"]
mod genuine_restart;

#[path = "genuine_crash_tests.rs"]
mod genuine_crash;
