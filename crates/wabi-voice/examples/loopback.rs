//! Runs the engine on real devices: captures a microphone, sends its relay
//! pages straight back into the engine as a remote stream and plays them.
//!
//!   cargo run --release --example loopback -- [--source NAME] [--sink NAME]
//!       [--seconds N] [--raw] [--list]
//!
//! Prints one line of counters per second and exits non-zero when no audible
//! audio made the round trip. With speakers and a microphone in the same room
//! you hear yourself about a tenth of a second late.
use std::sync::mpsc;
use std::time::{Duration, Instant};

use wabi_voice::engine::Engine;
use wabi_voice::processing::ProcessingOptions;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |flag: &str| args.iter().position(|arg| arg == flag).and_then(|index| args.get(index + 1)).cloned();
    let options = if args.iter().any(|arg| arg == "--raw") { ProcessingOptions::NONE } else { ProcessingOptions::default() };
    let mut engine = Engine::connect("wabi-voice-loopback", options).expect("audio server");
    if args.iter().any(|arg| arg == "--list") {
        for device in engine.input_devices().expect("inputs") {
            println!("input  {}{}  [{}]", if device.is_default { "* " } else { "  " }, device.description, device.name);
        }
        for device in engine.output_devices().expect("outputs") {
            println!("output {}{}  [{}]", if device.is_default { "* " } else { "  " }, device.description, device.name);
        }
        return;
    }
    let seconds: u64 = value("--seconds").and_then(|text| text.parse().ok()).unwrap_or(5);
    let (pages, received) = mpsc::channel();
    engine.start_playback(value("--sink").as_deref()).expect("playback");
    engine
        .start_capture(value("--source").as_deref(), move |page| {
            let _ = pages.send(page);
        })
        .expect("capture");
    let started = Instant::now();
    let mut next_report = Duration::from_secs(1);
    while started.elapsed() < Duration::from_secs(seconds) {
        if let Ok(page) = received.recv_timeout(Duration::from_millis(100)) {
            engine.push_remote("loopback", &page.bytes);
        }
        if started.elapsed() >= next_report {
            next_report += Duration::from_secs(1);
            let stats = engine.stats();
            let stream = stats.streams.first().map(|(_, stream)| *stream).unwrap_or_default();
            println!(
                "pages={} level={:.3} decoded={} failed={} audible={} played_ms={} dropped_ms={}",
                stats.pages_sent, stats.capture_level, stream.decode_ok, stream.decode_fail, stream.audible_chunks,
                stream.played_samples / 48, stream.dropped_overflow_samples / 48
            );
        }
    }
    let stats = engine.stats();
    engine.stop_capture();
    engine.stop_playback();
    let stream = stats.streams.first().map(|(_, stream)| *stream).unwrap_or_default();
    let pss = std::fs::read_to_string("/proc/self/smaps_rollup").ok()
        .and_then(|text| text.lines().find(|line| line.starts_with("Pss:")).and_then(|line| line.split_whitespace().nth(1).map(str::to_owned)));
    println!("pss_kb={}", pss.unwrap_or_default());
    if stream.audible_chunks == 0 || stream.played_samples == 0 || stream.decode_fail > 0 {
        eprintln!("FAIL: no audible audio made the round trip");
        std::process::exit(1);
    }
    println!("PASS");
}
