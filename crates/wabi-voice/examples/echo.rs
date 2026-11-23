//! Measures echo cancellation on real devices.
//!
//! The engine plays a far-end talker into `--sink` while capturing `--source`.
//! Route the sink back into the source (speakers and a microphone in a room,
//! or `pw-loopback` for a wired echo path) and nobody speaks locally, so
//! everything captured is echo. Prints the level of what would be sent.
//!
//!   pw-loopback --capture-props 'media.class=Audio/Sink node.name=echo_out' \
//!               --playback-props 'media.class=Audio/Source node.name=echo_mic' &
//!   cargo run --release --example echo -- --sink echo_out --source echo_mic [--raw]
//!
//! Run once with `--raw` and once without; the difference is the echo removed.
use std::sync::mpsc;
use std::time::{Duration, Instant};

use wabi_voice::engine::Engine;
use wabi_voice::pipeline::{CaptureChain, Mixer};
use wabi_voice::processing::{Passthrough, ProcessingOptions};

/// Noise in syllable-length bursts: speech-like enough to drive the canceller.
fn far_end(samples: usize) -> Vec<f32> {
    let mut state = 0x2545_f491u32;
    let mut low_pass = 0.0f32;
    (0..samples)
        .map(|n| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            low_pass += ((state as f32 / u32::MAX as f32) * 2.0 - 1.0 - low_pass) * 0.3;
            let phase = (n % 19_200) as f32 / 19_200.0;
            let envelope = if phase < 0.625 { (std::f32::consts::PI * phase / 0.625).sin() } else { 0.0 };
            low_pass * envelope * 0.8
        })
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |flag: &str| args.iter().position(|arg| arg == flag).and_then(|index| args.get(index + 1)).cloned();
    let raw = args.iter().any(|arg| arg == "--raw");
    let seconds: usize = value("--seconds").and_then(|text| text.parse().ok()).unwrap_or(15);
    let options = if raw { ProcessingOptions::NONE } else {
        // Echo cancellation alone, so the figure is not flattered by noise
        // suppression or moved by gain control.
        ProcessingOptions { echo_cancellation: true, noise_suppression: false, auto_gain: false, high_pass: true }
    };
    let mut engine = Engine::connect("wabi-voice-echo", options).expect("audio server");
    engine.start_playback(value("--sink").as_deref()).expect("playback");
    let (pages, captured) = mpsc::channel();
    engine.start_capture(value("--source").as_deref(), move |page| { let _ = pages.send(page); }).expect("capture");

    // The far-end talker, encoded as a remote sender would send it.
    let mut far_chain = CaptureChain::new(1).expect("encoder");
    let far = far_end(48_000 * seconds);
    // What the engine would send, decoded again to measure it.
    let mut sent = Mixer::new();
    let mut sent_pcm: Vec<f32> = Vec::new();
    let started = Instant::now();
    for (index, chunk) in far.chunks(960).enumerate() {
        for page in far_chain.push(chunk, &mut Passthrough).expect("encode") {
            engine.push_remote("far-end", &page.bytes);
        }
        while let Ok(page) = captured.try_recv() {
            sent.push("sent", &page.bytes);
        }
        let mut block = [0.0f32; 960];
        sent.pull(&mut block);
        sent_pcm.extend_from_slice(&block);
        let due = Duration::from_millis(20 * (index as u64 + 1));
        if let Some(wait) = due.checked_sub(started.elapsed()) { std::thread::sleep(wait); }
    }
    engine.stop_capture();
    engine.stop_playback();
    // Judge the last third, after the canceller has had time to converge.
    let tail = &sent_pcm[sent_pcm.len() * 2 / 3..];
    let power = tail.iter().map(|sample| (*sample as f64).powi(2)).sum::<f64>() / tail.len() as f64;
    println!("{} sent_level_db={:.1}", if raw { "raw" } else { "echo-cancelled" }, 10.0 * power.max(1e-12).log10());
}
