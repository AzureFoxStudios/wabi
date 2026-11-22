//! The engine on real devices, through the PulseAudio protocol.
//!
//! PipeWire desktops serve this protocol (pipewire-pulse) and so do
//! PulseAudio ones, and it is the audio socket Flatpak grants. The client is
//! pure Rust, so the shell needs no audio headers to build and links no audio
//! library.

use std::ffi::CString;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures::executor::block_on;
use pulseaudio::protocol;
use pulseaudio::{AsPlaybackSource, Client, PlaybackStream, RecordStream};

use crate::pipeline::{CaptureChain, Error, Mixer, OutPage, RenderTap, StreamStats};
use crate::processing::{Passthrough, ProcessingOptions, Processor, WebRtcProcessor, SAMPLE_RATE};

const BYTES_PER_SAMPLE: usize = 4; // f32, mono
/// Capture is delivered in pieces of about this long.
const CAPTURE_FRAGMENT_MS: u32 = 20;
/// Playback asks the server to hold about this much.
const PLAYBACK_TARGET_MS: u32 = 40;

impl From<pulseaudio::ClientError> for Error {
    fn from(error: pulseaudio::ClientError) -> Self {
        Self(format!("audio server: {error}"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    /// Stable name to pass back to `start_capture` or `start_playback`.
    pub name: String,
    pub description: String,
    pub is_default: bool,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct EngineStats {
    pub capturing: bool,
    pub playing: bool,
    /// Relay pages produced since capture started.
    pub pages_sent: u64,
    /// Peak of the latest processed microphone frame, 0 to 1.
    pub capture_level: f32,
    pub streams: Vec<(String, StreamStats)>,
}

struct Shared {
    mixer: Mutex<Mixer>,
    processor: Mutex<Box<dyn Processor>>,
    pages_sent: AtomicU64,
    capture_level_bits: std::sync::atomic::AtomicU32,
}

fn bytes_for_ms(milliseconds: u32) -> u32 {
    SAMPLE_RATE / 1000 * milliseconds * BYTES_PER_SAMPLE as u32
}

fn sample_spec() -> protocol::SampleSpec {
    protocol::SampleSpec {
        format: protocol::SampleFormat::Float32Le,
        channels: 1,
        sample_rate: SAMPLE_RATE,
    }
}

fn text(value: &CString) -> String {
    value.to_string_lossy().into_owned()
}

fn stream_props(role: &str) -> protocol::Props {
    let mut props = protocol::Props::new();
    props.set(protocol::Prop::MediaRole, CString::new("phone").unwrap());
    props.set(protocol::Prop::MediaName, CString::new(role).unwrap());
    props
}

/// One engine per app. Capture and playback start and stop independently.
pub struct Engine {
    client: Client,
    shared: Arc<Shared>,
    capture: Option<RecordStream>,
    playback: Option<PlaybackStream>,
    next_serial: u32,
}

impl Engine {
    /// Connects to the audio server named by the environment.
    pub fn connect(app_name: &str, options: ProcessingOptions) -> Result<Self, Error> {
        let name = CString::new(app_name).map_err(|_| Error("invalid app name".into()))?;
        let client = Client::from_env(name)?;
        let processor: Box<dyn Processor> = if options == ProcessingOptions::NONE {
            Box::new(Passthrough)
        } else {
            Box::new(WebRtcProcessor::new(options))
        };
        Ok(Self {
            client,
            shared: Arc::new(Shared {
                mixer: Mutex::new(Mixer::new()),
                processor: Mutex::new(processor),
                pages_sent: AtomicU64::new(0),
                capture_level_bits: std::sync::atomic::AtomicU32::new(0),
            }),
            capture: None,
            playback: None,
            next_serial: std::process::id().wrapping_mul(2_654_435_761),
        })
    }

    /// Microphones, without the monitors of output devices.
    pub fn input_devices(&self) -> Result<Vec<Device>, Error> {
        let default = block_on(self.client.server_info())?.default_source_name;
        Ok(block_on(self.client.list_sources())?
            .into_iter()
            .filter(|source| source.monitor_of_sink_index.is_none())
            .map(|source| Device {
                is_default: default.as_ref() == Some(&source.name),
                description: source.description.as_ref().map(text).unwrap_or_else(|| text(&source.name)),
                name: text(&source.name),
            })
            .collect())
    }

    pub fn output_devices(&self) -> Result<Vec<Device>, Error> {
        let default = block_on(self.client.server_info())?.default_sink_name;
        Ok(block_on(self.client.list_sinks())?
            .into_iter()
            .map(|sink| Device {
                is_default: default.as_ref() == Some(&sink.name),
                description: sink.description.as_ref().map(text).unwrap_or_else(|| text(&sink.name)),
                name: text(&sink.name),
            })
            .collect())
    }

    /// Starts sending the microphone. `on_page` receives each relay page, on
    /// the audio client's thread: it must hand the page on and return.
    /// `device` is a name from `input_devices`, or `None` for the default.
    /// A capture already running is replaced, and the new one starts a new
    /// stream (headers first, sequence from 0).
    pub fn start_capture(
        &mut self,
        device: Option<&str>,
        on_page: impl FnMut(OutPage) + Send + 'static,
    ) -> Result<(), Error> {
        self.start_capture_tapped(device, on_page, |_| {})
    }

    /// As [`start_capture`](Self::start_capture), and hands each processed
    /// 10 ms microphone frame (480 samples) to `on_frame`, for a transport
    /// that encodes for itself.
    pub fn start_capture_tapped(
        &mut self,
        device: Option<&str>,
        mut on_page: impl FnMut(OutPage) + Send + 'static,
        mut on_frame: impl FnMut(&[f32]) + Send + 'static,
    ) -> Result<(), Error> {
        self.stop_capture();
        self.next_serial = self.next_serial.wrapping_add(1);
        let mut chain = CaptureChain::new(self.next_serial)?;
        let shared = self.shared.clone();
        shared.pages_sent.store(0, Ordering::Relaxed);
        let mut samples: Vec<f32> = Vec::new();
        let mut leftover: Vec<u8> = Vec::new();
        let sink = move |data: &[u8]| {
            leftover.extend_from_slice(data);
            let whole = leftover.len() / BYTES_PER_SAMPLE * BYTES_PER_SAMPLE;
            samples.clear();
            samples.extend(
                leftover[..whole]
                    .chunks_exact(BYTES_PER_SAMPLE)
                    .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])),
            );
            leftover.drain(..whole);
            let pages = {
                let mut processor = shared.processor.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                chain.push_tapped(&samples, processor.as_mut(), &mut on_frame)
            };
            shared.capture_level_bits.store(chain.level().to_bits(), Ordering::Relaxed);
            match pages {
                Ok(pages) => {
                    shared.pages_sent.fetch_add(pages.len() as u64, Ordering::Relaxed);
                    pages.into_iter().for_each(&mut on_page);
                }
                Err(error) => log::warn!("Voice capture: {error}"),
            }
        };
        let params = protocol::RecordStreamParams {
            sample_spec: sample_spec(),
            channel_map: protocol::ChannelMap::mono(),
            source_name: match device {
                Some(name) => Some(CString::new(name).map_err(|_| Error("invalid device name".into()))?),
                None => Some(protocol::DEFAULT_SOURCE.to_owned()),
            },
            buffer_attr: protocol::stream::BufferAttr {
                max_length: u32::MAX,
                fragment_size: bytes_for_ms(CAPTURE_FRAGMENT_MS),
                ..Default::default()
            },
            flags: protocol::stream::StreamFlags {
                adjust_latency: true,
                ..Default::default()
            },
            props: stream_props("Wabi microphone"),
            ..Default::default()
        };
        self.capture = Some(block_on(self.client.create_record_stream(params, sink))?);
        Ok(())
    }

    /// Stops the microphone at once. Nothing more reaches `on_page`.
    pub fn stop_capture(&mut self) {
        if let Some(stream) = self.capture.take() {
            if let Err(error) = block_on(stream.delete()) {
                log::warn!("Voice capture did not close cleanly: {error}");
            }
        }
        self.shared.capture_level_bits.store(0, Ordering::Relaxed);
    }

    /// Starts playing what `push_remote` receives. `device` is a name from
    /// `output_devices`, or `None` for the default.
    pub fn start_playback(&mut self, device: Option<&str>) -> Result<(), Error> {
        self.stop_playback();
        let shared = self.shared.clone();
        let mut block: Vec<f32> = Vec::new();
        let mut tap = RenderTap::default();
        let source = move |buffer: &mut [u8]| -> usize {
            let frames = buffer.len() / BYTES_PER_SAMPLE;
            block.resize(frames, 0.0);
            shared.mixer.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).pull(&mut block);
            {
                let mut processor = shared.processor.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                tap.played(&block, processor.as_mut());
            }
            for (bytes, sample) in buffer.chunks_exact_mut(BYTES_PER_SAMPLE).zip(&block) {
                bytes.copy_from_slice(&sample.to_le_bytes());
            }
            frames * BYTES_PER_SAMPLE
        };
        let target = bytes_for_ms(PLAYBACK_TARGET_MS);
        let params = protocol::PlaybackStreamParams {
            sample_spec: sample_spec(),
            channel_map: protocol::ChannelMap::mono(),
            sink_name: match device {
                Some(name) => Some(CString::new(name).map_err(|_| Error("invalid device name".into()))?),
                None => Some(protocol::DEFAULT_SINK.to_owned()),
            },
            buffer_attr: protocol::stream::BufferAttr {
                max_length: u32::MAX,
                target_length: target,
                pre_buffering: 0,
                minimum_request_length: bytes_for_ms(10),
                ..Default::default()
            },
            flags: protocol::stream::StreamFlags {
                adjust_latency: true,
                ..Default::default()
            },
            cvolume: Some(protocol::ChannelVolume::norm(1)),
            props: stream_props("Wabi call"),
            ..Default::default()
        };
        self.shared
            .processor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .set_delay_ms((PLAYBACK_TARGET_MS + CAPTURE_FRAGMENT_MS) as i32);
        self.playback = Some(block_on(self.client.create_playback_stream(params, source.as_playback_source()))?);
        Ok(())
    }

    pub fn stop_playback(&mut self) {
        if let Some(stream) = self.playback.take() {
            if let Err(error) = block_on(stream.delete()) {
                log::warn!("Voice playback did not close cleanly: {error}");
            }
        }
    }

    /// Relay pages received from one sender's stream.
    pub fn push_remote(&self, stream: &str, bytes: &[u8]) {
        self.mixer().push(stream, bytes);
    }

    /// Mono 48 kHz samples from one sender, already decoded.
    pub fn push_remote_pcm(&self, stream: &str, pcm: &[f32]) {
        self.mixer().push_pcm(stream, pcm);
    }

    /// A handle for pushing received audio from other threads.
    pub fn remote_sink(&self) -> RemoteSink {
        RemoteSink(self.shared.clone())
    }

    pub fn remove_remote(&self, stream: &str) {
        self.mixer().remove(stream);
    }

    /// Drops every stream whose key starts with `prefix` (a call ended).
    pub fn remove_remote_group(&self, prefix: &str) {
        self.mixer().remove_group(prefix);
    }

    /// Volume for present and future streams whose key starts with `prefix`.
    pub fn set_remote_group_volume(&self, prefix: &str, volume: f32) {
        self.mixer().set_group_volume(prefix, volume);
    }

    pub fn clear_remotes(&self) {
        self.mixer().clear();
    }

    pub fn set_remote_volume(&self, stream: &str, volume: f32) {
        self.mixer().set_volume(stream, volume);
    }

    pub fn set_deafened(&self, deafened: bool) {
        self.mixer().set_deafened(deafened);
    }

    /// Streams that produced sound since the last call.
    pub fn take_activity(&self) -> Vec<String> {
        self.mixer().take_activity()
    }

    pub fn stats(&self) -> EngineStats {
        EngineStats {
            capturing: self.capture.is_some(),
            playing: self.playback.is_some(),
            pages_sent: self.shared.pages_sent.load(Ordering::Relaxed),
            capture_level: f32::from_bits(self.shared.capture_level_bits.load(Ordering::Relaxed)),
            streams: self.mixer().stats(),
        }
    }

    fn mixer(&self) -> std::sync::MutexGuard<'_, Mixer> {
        self.shared.mixer.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Pushes received audio into an [`Engine`] from any thread.
#[derive(Clone)]
pub struct RemoteSink(Arc<Shared>);

impl RemoteSink {
    fn mixer(&self) -> std::sync::MutexGuard<'_, Mixer> {
        self.0.mixer.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn push_pcm(&self, stream: &str, pcm: &[f32]) {
        self.mixer().push_pcm(stream, pcm);
    }

    pub fn remove(&self, stream: &str) {
        self.mixer().remove(stream);
    }

    pub fn remove_group(&self, prefix: &str) {
        self.mixer().remove_group(prefix);
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.stop_capture();
        self.stop_playback();
    }
}
