//! A LiveKit room on the engine's microphone and speakers.
//!
//! The Linux webview has no WebRTC, so the browser LiveKit client cannot run
//! there. This joins the room natively instead: the engine's processed
//! microphone is published as the participant's audio track, and every audio
//! track the room delivers is mixed into the engine's playback (and so into
//! the echo canceller's reference). Audio only.
//!
//! Connecting does not touch the [`Engine`](crate::engine::Engine), so it can
//! be awaited without holding it:
//!
//! ```ignore
//! let (call, microphone) = LiveKitCall::connect(url, token, engine.remote_sink(), "room:").await?;
//! engine.start_playback(None)?;
//! engine.start_capture_tapped(None, |_| {}, move |frame| microphone.send(frame))?;
//! ```

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::StreamExt;
use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use tokio::sync::mpsc;

use crate::engine::RemoteSink;
use crate::pipeline::Error;
use crate::processing::{FRAME, SAMPLE_RATE};

/// Hands processed microphone frames to the room. Give its
/// [`send`](Self::send) to `Engine::start_capture_tapped`.
#[derive(Clone)]
pub struct MicrophoneFeed(mpsc::Sender<Vec<i16>>);

impl MicrophoneFeed {
    /// One processed 10 ms frame. Never blocks: when the room cannot keep up
    /// the frame is dropped, which is what a live call wants.
    pub fn send(&self, frame: &[f32]) {
        let samples = frame
            .iter()
            .map(|sample| (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
            .collect();
        let _ = self.0.try_send(samples);
    }
}

pub struct LiveKitCall {
    room: Arc<Room>,
    microphone: LocalAudioTrack,
    connected: Arc<AtomicBool>,
    sink: RemoteSink,
    prefix: String,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl LiveKitCall {
    /// Joins the room `token` grants and publishes a microphone track.
    /// Received audio goes to `sink` under keys `{stream_prefix}{identity}`.
    /// Must be called on a Tokio runtime, which keeps running the call.
    pub async fn connect(
        url: &str,
        token: &str,
        sink: RemoteSink,
        stream_prefix: &str,
    ) -> Result<(Self, MicrophoneFeed), Error> {
        let (room, mut events) = Room::connect(url, token, RoomOptions::default())
            .await
            .map_err(|error| Error(format!("LiveKit: {error}")))?;
        let room = Arc::new(room);
        // The engine has already processed the microphone; the options turn
        // off a second round of processing inside the track.
        let options = AudioSourceOptions {
            echo_cancellation: false,
            noise_suppression: false,
            auto_gain_control: false,
        };
        let source = NativeAudioSource::new(options, SAMPLE_RATE, 1, 200);
        let microphone = LocalAudioTrack::create_audio_track("microphone", RtcAudioSource::Native(source.clone()));
        room.local_participant()
            .publish_track(
                LocalTrack::Audio(microphone.clone()),
                TrackPublishOptions {
                    source: TrackSource::Microphone,
                    ..Default::default()
                },
            )
            .await
            .map_err(|error| Error(format!("LiveKit publish: {error}")))?;

        let (feed, mut frames) = mpsc::channel::<Vec<i16>>(50);
        let send_task = tokio::spawn(async move {
            while let Some(samples) = frames.recv().await {
                let frame = AudioFrame {
                    data: samples.into(),
                    sample_rate: SAMPLE_RATE,
                    num_channels: 1,
                    samples_per_channel: FRAME as u32,
                };
                if source.capture_frame(&frame).await.is_err() {
                    break;
                }
            }
        });

        let connected = Arc::new(AtomicBool::new(true));
        let prefix = stream_prefix.to_owned();
        let receive_task = {
            let (connected, sink, prefix) = (connected.clone(), sink.clone(), prefix.clone());
            tokio::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        RoomEvent::TrackSubscribed {
                            track: RemoteTrack::Audio(audio),
                            participant,
                            ..
                        } => {
                            let key = format!("{prefix}{}", participant.identity().as_str());
                            let sink = sink.clone();
                            tokio::spawn(async move {
                                let mut stream = NativeAudioStream::new(audio.rtc_track(), SAMPLE_RATE as i32, 1);
                                let mut pcm = Vec::with_capacity(FRAME);
                                while let Some(frame) = stream.next().await {
                                    pcm.clear();
                                    pcm.extend(frame.data.iter().map(|sample| *sample as f32 / i16::MAX as f32));
                                    sink.push_pcm(&key, &pcm);
                                }
                                sink.remove(&key);
                            });
                        }
                        RoomEvent::ParticipantDisconnected(participant) => {
                            sink.remove(&format!("{prefix}{}", participant.identity().as_str()));
                        }
                        RoomEvent::Disconnected { .. } => {
                            connected.store(false, Ordering::Relaxed);
                            sink.remove_group(&prefix);
                            break;
                        }
                        _ => {}
                    }
                }
                connected.store(false, Ordering::Relaxed);
            })
        };

        Ok((
            Self {
                room,
                microphone,
                connected,
                sink,
                prefix,
                tasks: vec![send_task, receive_task],
            },
            MicrophoneFeed(feed),
        ))
    }

    /// False once the room has ended or the connection was lost for good.
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    /// Mutes or unmutes the published track for the room. The caller also
    /// stops or starts the engine's capture; this only tells the others.
    pub fn set_microphone_muted(&self, muted: bool) {
        if muted {
            self.microphone.mute();
        } else {
            self.microphone.unmute();
        }
    }

    pub fn remote_identities(&self) -> Vec<String> {
        self.room
            .remote_participants()
            .keys()
            .map(|identity| identity.as_str().to_owned())
            .collect()
    }

    /// Leaves the room and forgets its streams.
    pub async fn leave(self) {
        let _ = self.room.close().await;
        for task in &self.tasks {
            task.abort();
        }
        self.sink.remove_group(&self.prefix);
    }
}
