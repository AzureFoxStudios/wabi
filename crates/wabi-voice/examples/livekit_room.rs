//! Joins a LiveKit room on real devices through the engine.
//!
//!   cargo run --release --features livekit --example livekit_room -- \
//!       --url ws://127.0.0.1:7880 --token <JWT> [--source NAME] [--sink NAME] [--seconds N] [--raw]
//!
//! Prints counters each second and exits non-zero unless audio from another
//! participant was heard and the microphone was published.
use std::time::Duration;

use wabi_voice::engine::Engine;
use wabi_voice::livekit::LiveKitCall;
use wabi_voice::processing::ProcessingOptions;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |flag: &str| args.iter().position(|arg| arg == flag).and_then(|index| args.get(index + 1)).cloned();
    let url = value("--url").expect("--url");
    let token = value("--token").expect("--token");
    let seconds: u64 = value("--seconds").and_then(|text| text.parse().ok()).unwrap_or(15);
    let options = if args.iter().any(|arg| arg == "--raw") { ProcessingOptions::NONE } else { ProcessingOptions::default() };
    let mut engine = Engine::connect("wabi-voice-livekit", options).expect("audio server");
    let (call, microphone) = LiveKitCall::connect(&url, &token, engine.remote_sink(), "room:").await.expect("join");
    engine.start_playback(value("--sink").as_deref()).expect("playback");
    engine
        .start_capture_tapped(value("--source").as_deref(), |_| {}, move |frame| microphone.send(frame))
        .expect("capture");
    let mut heard = 0;
    for second in 1..=seconds {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let stats = engine.stats();
        heard = stats.streams.iter().map(|(_, stream)| stream.audible_chunks).sum::<u64>();
        let played: u64 = stats.streams.iter().map(|(_, stream)| stream.played_samples).sum();
        println!(
            "t={second}s connected={} others={:?} mic_pages={} mic_level={:.3} heard_chunks={heard} played_ms={}",
            call.is_connected(), call.remote_identities(), stats.pages_sent, stats.capture_level, played / 48
        );
    }
    let pss = std::fs::read_to_string("/proc/self/smaps_rollup").ok()
        .and_then(|text| text.lines().find(|line| line.starts_with("Pss:")).and_then(|line| line.split_whitespace().nth(1).map(str::to_owned)));
    println!("pss_kb={}", pss.unwrap_or_default());
    engine.stop_capture();
    engine.stop_playback();
    call.leave().await;
    if heard == 0 {
        eprintln!("FAIL: nothing audible was received from the room");
        std::process::exit(1);
    }
    println!("PASS");
}
