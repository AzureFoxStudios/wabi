//! Microphone processing: echo cancellation, noise suppression, gain control.
//!
//! Everything in the engine is mono 48 kHz, in 10 ms frames, as `f32` in
//! `[-1, 1]`.

use sonora::config::{EchoCanceller, GainController2, HighPassFilter, NoiseSuppression};
use sonora::{AudioProcessing, Config, StreamConfig};

pub const SAMPLE_RATE: u32 = 48_000;
/// Samples in one 10 ms frame.
pub const FRAME: usize = 480;

/// Which stages run on the microphone signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessingOptions {
    pub echo_cancellation: bool,
    pub noise_suppression: bool,
    pub auto_gain: bool,
    pub high_pass: bool,
}

impl Default for ProcessingOptions {
    fn default() -> Self {
        Self {
            echo_cancellation: true,
            noise_suppression: true,
            auto_gain: true,
            high_pass: true,
        }
    }
}

impl ProcessingOptions {
    pub const NONE: Self = Self {
        echo_cancellation: false,
        noise_suppression: false,
        auto_gain: false,
        high_pass: false,
    };
}

/// Processes the microphone and is told what the speakers play.
pub trait Processor: Send {
    /// One captured 10 ms frame, processed in place.
    fn process_capture(&mut self, frame: &mut [f32]);
    /// One 10 ms frame that is about to be played. The echo canceller removes
    /// what it later hears of this from the microphone.
    fn analyze_render(&mut self, frame: &[f32]);
    /// Rough time between a frame being handed to `analyze_render` and its
    /// echo arriving at `process_capture`.
    fn set_delay_ms(&mut self, _delay_ms: i32) {}
}

/// Leaves the microphone untouched.
pub struct Passthrough;

impl Processor for Passthrough {
    fn process_capture(&mut self, _frame: &mut [f32]) {}
    fn analyze_render(&mut self, _frame: &[f32]) {}
}

/// WebRTC's audio processing pipeline (AEC3, noise suppression, AGC2), as
/// ported to Rust by the `sonora` crate.
pub struct WebRtcProcessor {
    apm: AudioProcessing,
    scratch: [f32; FRAME],
    render_scratch: [f32; FRAME],
}

impl WebRtcProcessor {
    pub fn new(options: ProcessingOptions) -> Self {
        let config = Config {
            high_pass_filter: options.high_pass.then(HighPassFilter::default),
            echo_canceller: options.echo_cancellation.then(EchoCanceller::default),
            noise_suppression: options.noise_suppression.then(NoiseSuppression::default),
            gain_controller2: options.auto_gain.then(GainController2::default),
            ..Default::default()
        };
        let stream = StreamConfig::new(SAMPLE_RATE, 1);
        let apm = AudioProcessing::builder()
            .config(config)
            .capture_config(stream)
            .render_config(stream)
            .build();
        Self {
            apm,
            scratch: [0.0; FRAME],
            render_scratch: [0.0; FRAME],
        }
    }

    /// Echo return loss enhancement the canceller currently reports, in dB.
    pub fn echo_return_loss_enhancement(&self) -> Option<f64> {
        self.apm.statistics().echo_return_loss_enhancement
    }
}

impl Processor for WebRtcProcessor {
    fn process_capture(&mut self, frame: &mut [f32]) {
        debug_assert_eq!(frame.len(), FRAME);
        if self
            .apm
            .process_capture_f32(&[&*frame], &mut [&mut self.scratch[..]])
            .is_ok()
        {
            frame.copy_from_slice(&self.scratch);
        }
    }

    fn analyze_render(&mut self, frame: &[f32]) {
        debug_assert_eq!(frame.len(), FRAME);
        let _ = self
            .apm
            .process_render_f32(&[frame], &mut [&mut self.render_scratch[..]]);
    }

    fn set_delay_ms(&mut self, delay_ms: i32) {
        let _ = self.apm.set_stream_delay_ms(delay_ms);
    }
}
