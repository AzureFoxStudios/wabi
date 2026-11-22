//! Commands for the native voice engine (`crates/wabi-voice`).
//!
//! The page keeps call admission, signalling and the relay socket. In native
//! voice mode it sends received relay pages here to be decoded and played, and
//! gets the microphone back as relay pages to send. Linux only for now; on
//! other platforms every command reports the engine as unavailable.
//!
//! The microphone must never outlive the page's intent. Three things stop it
//! without the page asking: the page not polling for a few seconds (it hung,
//! crashed or lost its script state), the webview starting to load a document
//! (navigation or reload), and the app exiting.

use serde::Serialize;
use tauri::ipc::Channel;

/// One relay envelope of microphone audio.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicePage {
    pub seq: u32,
    /// The Ogg page, base64: the form the relay envelope carries.
    pub payload: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCapabilities {
    pub available: bool,
    /// Set by `WABI_NATIVE_VOICE=1`: use the engine without the page opting in.
    pub requested: bool,
    pub reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceDevice {
    pub name: String,
    pub description: String,
    pub is_default: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceDevices {
    pub inputs: Vec<VoiceDevice>,
    pub outputs: Vec<VoiceDevice>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStreamStatus {
    pub key: String,
    pub decode_ok: u64,
    pub decode_fail: u64,
    pub audible_chunks: u64,
    pub played_samples: u64,
    pub dropped_headerless: u64,
    pub dropped_overflow_samples: u64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub capturing: bool,
    pub playing: bool,
    pub pages_sent: u64,
    pub capture_level: f32,
    pub streams: Vec<VoiceStreamStatus>,
    /// Streams that produced sound since the previous poll.
    pub active: Vec<String>,
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use base64::Engine as _;
    use std::sync::{Arc, Mutex, MutexGuard};
    use std::time::{Duration, Instant};
    use wabi_voice::engine::Engine;
    use wabi_voice::processing::ProcessingOptions;

    /// Without a poll for this long the microphone is stopped.
    const POLL_DEADLINE: Duration = Duration::from_secs(5);

    #[derive(Default)]
    struct Inner {
        engine: Option<Engine>,
        last_poll: Option<Instant>,
        watchdog_running: bool,
    }

    #[derive(Default, Clone)]
    pub struct VoiceState(Arc<Mutex<Inner>>);

    impl VoiceState {
        fn lock(&self) -> MutexGuard<'_, Inner> {
            self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
        }

        fn with_engine<T>(&self, run: impl FnOnce(&mut Engine) -> Result<T, String>) -> Result<T, String> {
            let mut inner = self.lock();
            if inner.engine.is_none() {
                inner.engine = Some(
                    Engine::connect("Wabi", ProcessingOptions::default()).map_err(|error| error.to_string())?,
                );
            }
            run(inner.engine.as_mut().expect("engine was just created"))
        }

        /// Stops the microphone and playback and forgets every stream.
        pub fn shutdown(&self, why: &str) {
            let mut inner = self.lock();
            if let Some(mut engine) = inner.engine.take() {
                let was_capturing = engine.stats().capturing;
                engine.stop_capture();
                engine.stop_playback();
                if was_capturing {
                    log::info!("Voice engine stopped the microphone: {why}");
                }
            }
            inner.last_poll = None;
        }

        fn ensure_watchdog(&self) {
            let mut inner = self.lock();
            if inner.watchdog_running {
                return;
            }
            inner.watchdog_running = true;
            let state = self.clone();
            std::thread::Builder::new()
                .name("voice-watchdog".into())
                .spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(1));
                    let mut inner = state.lock();
                    let stale = inner.last_poll.is_none_or(|at| at.elapsed() > POLL_DEADLINE);
                    let Some(engine) = inner.engine.as_mut() else {
                        inner.watchdog_running = false;
                        return;
                    };
                    if stale && engine.stats().capturing {
                        engine.stop_capture();
                        log::warn!("Voice engine stopped the microphone: the page stopped polling");
                    }
                })
                .ok();
        }
    }

    fn map_devices(devices: Vec<wabi_voice::engine::Device>) -> Vec<VoiceDevice> {
        devices
            .into_iter()
            .map(|device| VoiceDevice {
                name: device.name,
                description: device.description,
                is_default: device.is_default,
            })
            .collect()
    }

    pub fn capabilities() -> VoiceCapabilities {
        VoiceCapabilities {
            available: true,
            requested: std::env::var("WABI_NATIVE_VOICE").as_deref() == Ok("1"),
            reason: None,
        }
    }

    pub fn devices(state: &VoiceState) -> Result<VoiceDevices, String> {
        state.with_engine(|engine| {
            Ok(VoiceDevices {
                inputs: map_devices(engine.input_devices().map_err(|error| error.to_string())?),
                outputs: map_devices(engine.output_devices().map_err(|error| error.to_string())?),
            })
        })
    }

    /// `WABI_VOICE_SOURCE` / `WABI_VOICE_SINK` name the device to use when the
    /// page does not choose one (there is no device picker for the engine yet).
    fn device_or_env(device: Option<String>, variable: &str) -> Option<String> {
        device.or_else(|| std::env::var(variable).ok().filter(|name| !name.is_empty()))
    }

    pub fn capture_start(state: &VoiceState, device: Option<String>, on_page: Channel<VoicePage>) -> Result<(), String> {
        let device = device_or_env(device, "WABI_VOICE_SOURCE");
        state.with_engine(|engine| {
            engine
                .start_capture(device.as_deref(), move |page| {
                    let _ = on_page.send(VoicePage {
                        seq: page.seq,
                        payload: base64::engine::general_purpose::STANDARD.encode(&page.bytes),
                    });
                })
                .map_err(|error| error.to_string())
        })?;
        state.lock().last_poll = Some(Instant::now());
        state.ensure_watchdog();
        Ok(())
    }

    pub fn capture_stop(state: &VoiceState) {
        if let Some(engine) = state.lock().engine.as_mut() {
            engine.stop_capture();
        }
    }

    pub fn playback_start(state: &VoiceState, device: Option<String>) -> Result<(), String> {
        let device = device_or_env(device, "WABI_VOICE_SINK");
        state.with_engine(|engine| {
            if engine.stats().playing {
                return Ok(());
            }
            engine.start_playback(device.as_deref()).map_err(|error| error.to_string())
        })
    }

    pub fn push(state: &VoiceState, stream: &str, payload: &str) -> Result<(), String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload)
            .map_err(|error| error.to_string())?;
        if let Some(engine) = state.lock().engine.as_ref() {
            engine.push_remote(stream, &bytes);
        }
        Ok(())
    }

    pub fn with_running(state: &VoiceState, run: impl FnOnce(&Engine)) {
        if let Some(engine) = state.lock().engine.as_ref() {
            run(engine);
        }
    }

    pub fn poll(state: &VoiceState) -> VoiceStatus {
        let mut inner = state.lock();
        inner.last_poll = Some(Instant::now());
        let Some(engine) = inner.engine.as_ref() else {
            return VoiceStatus::default();
        };
        let stats = engine.stats();
        VoiceStatus {
            capturing: stats.capturing,
            playing: stats.playing,
            pages_sent: stats.pages_sent,
            capture_level: stats.capture_level,
            active: engine.take_activity(),
            streams: stats
                .streams
                .into_iter()
                .map(|(key, stream)| VoiceStreamStatus {
                    key,
                    decode_ok: stream.decode_ok,
                    decode_fail: stream.decode_fail,
                    audible_chunks: stream.audible_chunks,
                    played_samples: stream.played_samples,
                    dropped_headerless: stream.dropped_headerless,
                    dropped_overflow_samples: stream.dropped_overflow_samples,
                })
                .collect(),
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux::VoiceState;

#[cfg(not(target_os = "linux"))]
#[derive(Default, Clone)]
pub struct VoiceState;

#[cfg(not(target_os = "linux"))]
impl VoiceState {
    pub fn shutdown(&self, _why: &str) {}
}

#[cfg(not(target_os = "linux"))]
const UNAVAILABLE: &str = "The native voice engine is only built for Linux.";

#[tauri::command]
pub fn voice_capabilities() -> VoiceCapabilities {
    #[cfg(target_os = "linux")]
    return linux::capabilities();
    #[cfg(not(target_os = "linux"))]
    VoiceCapabilities {
        available: false,
        requested: false,
        reason: Some(UNAVAILABLE.into()),
    }
}

#[tauri::command]
pub async fn voice_devices(state: tauri::State<'_, VoiceState>) -> Result<VoiceDevices, String> {
    #[cfg(target_os = "linux")]
    return linux::devices(&state);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = state;
        Err(UNAVAILABLE.into())
    }
}

/// Starts sending the microphone as relay pages on `on_page`. Replaces a
/// capture already running; the new one starts a new stream.
#[tauri::command]
pub async fn voice_capture_start(
    state: tauri::State<'_, VoiceState>,
    device: Option<String>,
    on_page: Channel<VoicePage>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return linux::capture_start(&state, device, on_page);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, device, on_page);
        Err(UNAVAILABLE.into())
    }
}

#[tauri::command]
pub async fn voice_capture_stop(state: tauri::State<'_, VoiceState>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    linux::capture_stop(&state);
    let _ = &state;
    Ok(())
}

#[tauri::command]
pub async fn voice_playback_start(state: tauri::State<'_, VoiceState>, device: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return linux::playback_start(&state, device);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, device);
        Err(UNAVAILABLE.into())
    }
}

/// Received relay pages for one sender's stream; `payload` is the envelope's
/// base64 field as it arrived.
#[tauri::command]
pub fn voice_push(state: tauri::State<'_, VoiceState>, stream: String, payload: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return linux::push(&state, &stream, &payload);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, stream, payload);
        Err(UNAVAILABLE.into())
    }
}

/// Forgets every stream whose key starts with `prefix`: that call ended.
#[tauri::command]
pub fn voice_remove_group(state: tauri::State<'_, VoiceState>, prefix: String) {
    #[cfg(target_os = "linux")]
    linux::with_running(&state, |engine| engine.remove_remote_group(&prefix));
    let _ = (&state, &prefix);
}

/// Volume, 0 to 1, for the streams whose key starts with `prefix`.
#[tauri::command]
pub fn voice_set_group_volume(state: tauri::State<'_, VoiceState>, prefix: String, volume: f32) {
    #[cfg(target_os = "linux")]
    linux::with_running(&state, |engine| engine.set_remote_group_volume(&prefix, volume));
    let _ = (&state, &prefix, volume);
}

#[tauri::command]
pub fn voice_set_deafened(state: tauri::State<'_, VoiceState>, deafened: bool) {
    #[cfg(target_os = "linux")]
    linux::with_running(&state, |engine| engine.set_deafened(deafened));
    let _ = (&state, deafened);
}

/// Counters, and the page's sign of life: capture stops when this is not
/// called for a few seconds.
#[tauri::command]
pub fn voice_poll(state: tauri::State<'_, VoiceState>) -> VoiceStatus {
    #[cfg(target_os = "linux")]
    return linux::poll(&state);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = state;
        VoiceStatus::default()
    }
}

/// Stops the microphone and playback and forgets every stream.
#[tauri::command]
pub async fn voice_shutdown(state: tauri::State<'_, VoiceState>) -> Result<(), String> {
    state.shutdown("the page asked");
    Ok(())
}
