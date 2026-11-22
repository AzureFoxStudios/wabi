//! The engine without devices: microphone samples in, relay pages out; relay
//! pages in, speaker samples out. Everything here is deterministic and runs in
//! tests without an audio server.
//!
//! Wire format (must match the browser clients, `relayAudioCapture.ts`): an
//! Ogg Opus stream, mono, 48 kHz, 20 ms packets, two packets per page, one
//! page per envelope. Envelope 0 is the OpusHead page and envelope 1 the
//! OpusTags page; the server caches those two for people who join later.

use std::collections::{HashMap, VecDeque};

use crate::ogg::{PageReader, PageWriter};
use crate::processing::{Processor, FRAME, SAMPLE_RATE};

/// Samples in one Opus packet (20 ms).
const PACKET_SAMPLES: usize = 960;
const PACKETS_PER_PAGE: usize = 2;
/// A decoded sample above this counts as sound, the same threshold the
/// browser client uses for its speaking indicator.
const AUDIBLE: f32 = 0.01;
/// Playout starts once this much is buffered, to ride out arrival jitter.
const PREBUFFER_SAMPLES: usize = SAMPLE_RATE as usize * 60 / 1000;
/// Beyond this the oldest audio is dropped so playback cannot fall behind.
const MAX_BUFFER_SAMPLES: usize = SAMPLE_RATE as usize / 2;

#[derive(Debug)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<opus::Error> for Error {
    fn from(error: opus::Error) -> Self {
        Self(format!("Opus: {error}"))
    }
}

/// One relay envelope's worth of outgoing audio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutPage {
    /// Envelope sequence number, from 0 for each new capture.
    pub seq: u32,
    pub bytes: Vec<u8>,
}

/// Microphone samples to relay pages.
pub struct CaptureChain {
    encoder: opus::Encoder,
    writer: PageWriter,
    /// Captured samples that do not yet fill a 10 ms frame.
    unprocessed: Vec<f32>,
    /// Processed samples that do not yet fill a packet.
    processed: Vec<f32>,
    packets: Vec<Vec<u8>>,
    granule: u64,
    seq: u32,
    headers_sent: bool,
    pre_skip: u16,
    level: f32,
}

impl CaptureChain {
    /// `serial` identifies the Ogg stream; any value distinct per capture.
    pub fn new(serial: u32) -> Result<Self, Error> {
        let mut encoder =
            opus::Encoder::new(SAMPLE_RATE, opus::Channels::Mono, opus::Application::Voip)?;
        encoder.set_bitrate(opus::Bitrate::Bits(32_000))?;
        encoder.set_inband_fec(true)?;
        encoder.set_packet_loss_perc(5)?;
        let pre_skip = encoder.get_lookahead()? as u16;
        Ok(Self {
            encoder,
            writer: PageWriter::new(serial),
            unprocessed: Vec::with_capacity(FRAME * 2),
            processed: Vec::with_capacity(PACKET_SAMPLES * 2),
            packets: Vec::with_capacity(PACKETS_PER_PAGE),
            granule: 0,
            seq: 0,
            headers_sent: false,
            pre_skip,
            level: 0.0,
        })
    }

    /// Peak of the most recent processed frame, 0 to 1.
    pub fn level(&self) -> f32 {
        self.level
    }

    fn header_pages(&mut self) -> [OutPage; 2] {
        let mut head = Vec::with_capacity(19);
        head.extend_from_slice(b"OpusHead");
        head.push(1); // version
        head.push(1); // channels
        head.extend_from_slice(&self.pre_skip.to_le_bytes());
        head.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        head.extend_from_slice(&0i16.to_le_bytes()); // output gain
        head.push(0); // channel mapping family
        let vendor = b"wabi-voice";
        let mut tags = Vec::with_capacity(16 + vendor.len());
        tags.extend_from_slice(b"OpusTags");
        tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
        tags.extend_from_slice(vendor);
        tags.extend_from_slice(&0u32.to_le_bytes()); // no comments
        let first = self.out(|writer| writer.page(&[&head], 0, true, false));
        let second = self.out(|writer| writer.page(&[&tags], 0, false, false));
        [first, second]
    }

    fn out(&mut self, build: impl FnOnce(&mut PageWriter) -> Vec<u8>) -> OutPage {
        let page = OutPage {
            seq: self.seq,
            bytes: build(&mut self.writer),
        };
        self.seq += 1;
        page
    }

    /// Feeds captured samples (any amount) and returns the pages they complete.
    pub fn push(
        &mut self,
        samples: &[f32],
        processor: &mut dyn Processor,
    ) -> Result<Vec<OutPage>, Error> {
        let mut pages = Vec::new();
        if !self.headers_sent {
            pages.extend(self.header_pages());
            self.headers_sent = true;
        }
        self.unprocessed.extend_from_slice(samples);
        let mut offset = 0;
        while self.unprocessed.len() - offset >= FRAME {
            let mut frame = [0.0f32; FRAME];
            frame.copy_from_slice(&self.unprocessed[offset..offset + FRAME]);
            offset += FRAME;
            processor.process_capture(&mut frame);
            self.level = frame.iter().fold(0.0f32, |peak, sample| peak.max(sample.abs()));
            self.processed.extend_from_slice(&frame);
        }
        self.unprocessed.drain(..offset);

        let mut encoded = [0u8; 1500];
        let mut consumed = 0;
        while self.processed.len() - consumed >= PACKET_SAMPLES {
            let length = self
                .encoder
                .encode_float(&self.processed[consumed..consumed + PACKET_SAMPLES], &mut encoded)?;
            consumed += PACKET_SAMPLES;
            self.granule += PACKET_SAMPLES as u64;
            self.packets.push(encoded[..length].to_vec());
            if self.packets.len() == PACKETS_PER_PAGE {
                let packets = std::mem::take(&mut self.packets);
                let granule = self.granule;
                let borrowed: Vec<&[u8]> = packets.iter().map(Vec::as_slice).collect();
                pages.push(self.out(|writer| writer.page(&borrowed, granule, false, false)));
            }
        }
        self.processed.drain(..consumed);
        Ok(pages)
    }
}

/// Counters for one received stream. Names follow the browser client's relay
/// diagnostics so the same checks read both.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct StreamStats {
    pub decode_ok: u64,
    pub decode_fail: u64,
    /// Decoded packets that were not silence.
    pub audible_chunks: u64,
    /// Samples handed to the speakers.
    pub played_samples: u64,
    /// Pages that arrived before this stream's headers.
    pub dropped_headerless: u64,
    /// Samples dropped because playback had fallen too far behind.
    pub dropped_overflow_samples: u64,
}

struct RemoteStream {
    reader: PageReader,
    decoder: Option<opus::Decoder>,
    queue: VecDeque<f32>,
    playing: bool,
    volume: f32,
    /// Volume of the group (call) this stream belongs to.
    group_volume: f32,
    stats: StreamStats,
    /// Set when a packet was audible; cleared by `Mixer::take_activity`.
    active: bool,
}

impl RemoteStream {
    fn new() -> Self {
        Self {
            reader: PageReader::default(),
            decoder: None,
            queue: VecDeque::new(),
            playing: false,
            volume: 1.0,
            group_volume: 1.0,
            stats: StreamStats::default(),
            active: false,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        for packet in self.reader.push(bytes) {
            if packet.data.starts_with(b"OpusHead") {
                // A new stream from this sender (first join, unmute, rejoin):
                // start a fresh decoder and drop audio of the old one.
                self.decoder = opus::Decoder::new(SAMPLE_RATE, opus::Channels::Mono).ok();
                self.queue.clear();
                self.playing = false;
                continue;
            }
            if packet.data.starts_with(b"OpusTags") {
                continue;
            }
            let Some(decoder) = self.decoder.as_mut() else {
                self.stats.dropped_headerless += 1;
                continue;
            };
            // 120 ms is the longest Opus packet.
            let mut pcm = [0.0f32; 5760];
            match decoder.decode_float(&packet.data, &mut pcm, false) {
                Ok(samples) => {
                    self.stats.decode_ok += 1;
                    let pcm = &pcm[..samples];
                    if pcm.iter().any(|sample| sample.abs() > AUDIBLE) {
                        self.stats.audible_chunks += 1;
                        self.active = true;
                    }
                    self.queue.extend(pcm);
                }
                Err(_) => self.stats.decode_fail += 1,
            }
        }
        if self.queue.len() > MAX_BUFFER_SAMPLES {
            let excess = self.queue.len() - MAX_BUFFER_SAMPLES;
            self.queue.drain(..excess);
            self.stats.dropped_overflow_samples += excess as u64;
        }
    }

    fn mix_into(&mut self, out: &mut [f32], gain: f32) {
        if !self.playing {
            if self.queue.len() < PREBUFFER_SAMPLES {
                return;
            }
            self.playing = true;
        }
        let available = self.queue.len().min(out.len());
        for (slot, sample) in out.iter_mut().zip(self.queue.drain(..available)) {
            *slot += sample * self.volume * self.group_volume * gain;
        }
        self.stats.played_samples += available as u64;
        if available < out.len() {
            self.playing = false; // ran dry: buffer again before resuming
        }
    }
}

/// Relay pages from any number of senders to one mono speaker signal.
pub struct Mixer {
    streams: HashMap<String, RemoteStream>,
    /// Volume per key prefix. One call's streams share a prefix.
    group_volumes: Vec<(String, f32)>,
    deafened: bool,
}

impl Default for Mixer {
    fn default() -> Self {
        Self::new()
    }
}

impl Mixer {
    pub fn new() -> Self {
        Self {
            streams: HashMap::new(),
            group_volumes: Vec::new(),
            deafened: false,
        }
    }

    /// Pages from one sender's stream. `stream` is any key unique per sender
    /// and source (the browser client keys by account, socket and
    /// microphone/screen).
    pub fn push(&mut self, stream: &str, bytes: &[u8]) {
        self.entry(stream).push(bytes);
    }

    fn entry(&mut self, stream: &str) -> &mut RemoteStream {
        let group_volumes = &self.group_volumes;
        self.streams.entry(stream.to_owned()).or_insert_with(|| {
            let mut created = RemoteStream::new();
            if let Some((_, volume)) = group_volumes.iter().find(|(prefix, _)| stream.starts_with(prefix.as_str())) {
                created.group_volume = *volume;
            }
            created
        })
    }

    /// Drops every stream whose key starts with `prefix`, and that prefix's
    /// volume: a call ended.
    pub fn remove_group(&mut self, prefix: &str) {
        self.streams.retain(|key, _| !key.starts_with(prefix));
        self.group_volumes.retain(|(known, _)| known != prefix);
    }

    /// Volume for every present and future stream whose key starts with
    /// `prefix`. 1.0 is unchanged; clamped to 0..=4.
    pub fn set_group_volume(&mut self, prefix: &str, volume: f32) {
        let volume = volume.clamp(0.0, 4.0);
        self.group_volumes.retain(|(known, _)| known != prefix);
        self.group_volumes.push((prefix.to_owned(), volume));
        for (key, stream) in self.streams.iter_mut() {
            if key.starts_with(prefix) {
                stream.group_volume = volume;
            }
        }
    }

    pub fn remove(&mut self, stream: &str) {
        self.streams.remove(stream);
    }

    pub fn clear(&mut self) {
        self.streams.clear();
        self.group_volumes.clear();
    }

    /// 1.0 is unchanged; values are clamped to 0..=4.
    pub fn set_volume(&mut self, stream: &str, volume: f32) {
        self.entry(stream).volume = volume.clamp(0.0, 4.0);
    }

    /// While deafened, streams keep decoding and draining so that undeafening
    /// resumes live, but nothing reaches the speakers.
    pub fn set_deafened(&mut self, deafened: bool) {
        self.deafened = deafened;
    }

    /// Fills `out` with the next samples to play; silence where there is none.
    pub fn pull(&mut self, out: &mut [f32]) {
        out.fill(0.0);
        let gain = if self.deafened { 0.0 } else { 1.0 };
        for stream in self.streams.values_mut() {
            stream.mix_into(out, gain);
        }
        for sample in out.iter_mut() {
            *sample = sample.clamp(-1.0, 1.0);
        }
    }

    pub fn stats(&self) -> Vec<(String, StreamStats)> {
        self.streams
            .iter()
            .map(|(key, stream)| (key.clone(), stream.stats))
            .collect()
    }

    /// Streams that produced sound since the last call.
    pub fn take_activity(&mut self) -> Vec<String> {
        self.streams
            .iter_mut()
            .filter_map(|(key, stream)| std::mem::take(&mut stream.active).then(|| key.clone()))
            .collect()
    }
}

/// Cuts the speaker signal into the 10 ms frames the echo canceller wants.
#[derive(Default)]
pub struct RenderTap {
    pending: Vec<f32>,
}

impl RenderTap {
    /// Call with every block handed to the speakers, in order.
    pub fn played(&mut self, block: &[f32], processor: &mut dyn Processor) {
        self.pending.extend_from_slice(block);
        let mut offset = 0;
        while self.pending.len() - offset >= FRAME {
            processor.analyze_render(&self.pending[offset..offset + FRAME]);
            offset += FRAME;
        }
        self.pending.drain(..offset);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processing::{Passthrough, ProcessingOptions, WebRtcProcessor};

    fn tone(samples: usize, frequency: f32, amplitude: f32) -> Vec<f32> {
        (0..samples)
            .map(|n| (n as f32 * frequency * std::f32::consts::TAU / SAMPLE_RATE as f32).sin() * amplitude)
            .collect()
    }

    /// Magnitude of one frequency in a signal (Goertzel), as peak amplitude.
    fn amplitude_at(signal: &[f32], frequency: f32) -> f32 {
        let omega = frequency * std::f32::consts::TAU / SAMPLE_RATE as f32;
        let (mut real, mut imaginary) = (0.0f64, 0.0f64);
        for (n, sample) in signal.iter().enumerate() {
            real += (*sample as f64) * (omega as f64 * n as f64).cos();
            imaginary += (*sample as f64) * (omega as f64 * n as f64).sin();
        }
        (2.0 * (real * real + imaginary * imaginary).sqrt() / signal.len() as f64) as f32
    }

    fn power(signal: &[f32]) -> f64 {
        signal.iter().map(|sample| (*sample as f64).powi(2)).sum::<f64>() / signal.len().max(1) as f64
    }

    #[test]
    fn first_two_envelopes_are_the_headers_the_server_caches() {
        let mut chain = CaptureChain::new(1).unwrap();
        // Uneven chunk sizes, as an audio server delivers them.
        let signal = tone(SAMPLE_RATE as usize / 2, 440.0, 0.3);
        let mut pages = Vec::new();
        for chunk in signal.chunks(777) {
            pages.extend(chain.push(chunk, &mut Passthrough).unwrap());
        }
        let sequence: Vec<u32> = pages.iter().map(|page| page.seq).collect();
        assert_eq!(sequence, (0..pages.len() as u32).collect::<Vec<_>>());
        let mut reader = PageReader::default();
        let head = reader.push(&pages[0].bytes);
        assert!(head[0].bos && head[0].data.starts_with(b"OpusHead"));
        assert_eq!(head[0].data.len(), 19);
        assert_eq!(head[0].data[9], 1, "mono");
        assert!(reader.push(&pages[1].bytes)[0].data.starts_with(b"OpusTags"));
        // 500 ms is 25 packets: 12 full pages of two.
        assert_eq!(pages.len(), 2 + 12);
        for page in &pages[2..] {
            assert_eq!(reader.push(&page.bytes).len(), PACKETS_PER_PAGE);
        }
    }

    #[test]
    fn a_tone_survives_capture_relay_and_playback() {
        let mut chain = CaptureChain::new(2).unwrap();
        let mut mixer = Mixer::new();
        let mut played = Vec::new();
        for chunk in tone(SAMPLE_RATE as usize * 2, 440.0, 0.3).chunks(960) {
            for page in chain.push(chunk, &mut Passthrough).unwrap() {
                mixer.push("alice", &page.bytes);
            }
            let mut block = [0.0f32; 960];
            mixer.pull(&mut block);
            played.extend_from_slice(&block);
        }
        let steady = &played[SAMPLE_RATE as usize..];
        let level = amplitude_at(steady, 440.0);
        assert!((0.25..0.35).contains(&level), "440 Hz came back at {level}");
        assert!(amplitude_at(steady, 1000.0) < 0.01);
        let (_, stats) = mixer.stats().pop().unwrap();
        assert_eq!(stats.decode_fail, 0);
        assert!(stats.audible_chunks > 80 && stats.decode_ok >= stats.audible_chunks);
        assert!(stats.played_samples > SAMPLE_RATE as u64);
        assert_eq!(mixer.take_activity(), vec!["alice".to_owned()]);
        assert!(mixer.take_activity().is_empty());
    }

    #[test]
    fn pages_before_the_headers_are_dropped_and_a_new_head_restarts_the_stream() {
        let mut chain = CaptureChain::new(3).unwrap();
        let pages = chain.push(&tone(9600, 440.0, 0.3), &mut Passthrough).unwrap();
        let mut mixer = Mixer::new();
        mixer.push("bob", &pages[4].bytes); // data before headers (joined late, no replay)
        assert_eq!(mixer.stats()[0].1.dropped_headerless, PACKETS_PER_PAGE as u64);
        for page in &pages {
            mixer.push("bob", &page.bytes);
        }
        assert!(mixer.stats()[0].1.decode_ok > 0);
        // The sender unmutes: a new capture, new headers, sequence from 0.
        let mut again = CaptureChain::new(4).unwrap();
        for page in again.push(&tone(9600, 440.0, 0.3), &mut Passthrough).unwrap() {
            mixer.push("bob", &page.bytes);
        }
        assert_eq!(mixer.stats()[0].1.decode_fail, 0);
    }

    #[test]
    fn deafen_silences_output_volume_scales_it_and_streams_mix() {
        let mut mixer = Mixer::new();
        for (name, frequency) in [("low", 300.0), ("high", 2000.0)] {
            let mut chain = CaptureChain::new(5).unwrap();
            for page in chain.push(&tone(SAMPLE_RATE as usize * 2, frequency, 0.2), &mut Passthrough).unwrap() {
                mixer.push(name, &page.bytes);
            }
        }
        mixer.set_volume("high", 0.5);
        let mut block = vec![0.0f32; 4800];
        mixer.pull(&mut block); // settle the decoder
        mixer.pull(&mut block);
        let low = amplitude_at(&block, 300.0);
        let high = amplitude_at(&block, 2000.0);
        assert!((0.15..0.25).contains(&low), "low {low}");
        assert!((0.07..0.13).contains(&high), "high at half volume {high}");
        mixer.set_group_volume("lo", 0.5); // "low" belongs to group "lo"
        mixer.pull(&mut block);
        let halved = amplitude_at(&block, 300.0);
        assert!((0.07..0.13).contains(&halved), "low at half group volume {halved}");
        mixer.set_deafened(true);
        mixer.pull(&mut block);
        assert!(block.iter().all(|sample| *sample == 0.0));
        mixer.remove_group("lo");
        assert_eq!(mixer.stats().len(), 1);
    }

    #[test]
    fn overflow_drops_old_audio_instead_of_falling_behind() {
        let mut chain = CaptureChain::new(6).unwrap();
        let mut mixer = Mixer::new();
        for page in chain.push(&tone(SAMPLE_RATE as usize * 3, 440.0, 0.3), &mut Passthrough).unwrap() {
            mixer.push("carol", &page.bytes);
        }
        let stats = mixer.stats()[0].1;
        assert!(stats.dropped_overflow_samples > SAMPLE_RATE as u64 * 2);
    }

    /// Speech-like test signal: noise through a slow random amplitude envelope.
    fn babble(samples: usize, seed: u32) -> Vec<f32> {
        let mut state = seed;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state as f32 / u32::MAX as f32) * 2.0 - 1.0
        };
        let mut envelope = 0.0f32;
        let mut target = 0.5f32;
        let mut low_pass = 0.0f32;
        (0..samples)
            .map(|n| {
                if n % 4800 == 0 {
                    target = 0.1 + 0.4 * (next() * 0.5 + 0.5);
                }
                envelope += (target - envelope) * 0.001;
                low_pass += (next() - low_pass) * 0.25;
                low_pass * envelope
            })
            .collect()
    }

    /// The far end talks, the microphone hears only its echo (delayed and
    /// attenuated, as from speakers), and nobody speaks locally. With the
    /// processor on, far less of that echo may be sent back than with it off.
    #[test]
    fn echo_cancellation_removes_most_of_the_far_end_echo() {
        let seconds = 12;
        let far = babble(SAMPLE_RATE as usize * seconds, 0x9e37_79b9);
        let delay = SAMPLE_RATE as usize * 40 / 1000;
        let echo_at = |n: usize| if n >= delay { far[n - delay] * 0.5 } else { 0.0 };

        let run = |processor: &mut dyn Processor| -> f64 {
            let mut tap = RenderTap::default();
            let mut sent = Vec::new();
            for frame_index in 0..far.len() / FRAME {
                let start = frame_index * FRAME;
                tap.played(&far[start..start + FRAME], processor);
                let mut microphone: Vec<f32> = (start..start + FRAME).map(echo_at).collect();
                processor.process_capture(&mut microphone);
                sent.extend_from_slice(&microphone);
            }
            // Judge the last third, after the canceller has converged.
            power(&sent[sent.len() * 2 / 3..])
        };

        let untouched = run(&mut Passthrough);
        let mut processor = WebRtcProcessor::new(ProcessingOptions {
            echo_cancellation: true,
            noise_suppression: false,
            auto_gain: false,
            high_pass: true,
        });
        processor.set_delay_ms(40);
        let cancelled = run(&mut processor);
        let reduction_db = 10.0 * (untouched / cancelled.max(1e-12)).log10();
        println!("echo reduction: {reduction_db:.1} dB (reported ERLE {:?})", processor.echo_return_loss_enhancement());
        assert!(reduction_db > 20.0, "echo reduced by only {reduction_db:.1} dB");
    }

    /// With nobody at the far end, local speech must pass through the full
    /// processor rather than being suppressed with the echo.
    #[test]
    fn local_speech_passes_the_processor() {
        let near = babble(SAMPLE_RATE as usize * 6, 0x1234_5678);
        let mut processor = WebRtcProcessor::new(ProcessingOptions::default());
        let mut tap = RenderTap::default();
        let silence = [0.0f32; FRAME];
        let mut sent = Vec::new();
        for frame in near.chunks_exact(FRAME) {
            tap.played(&silence, &mut processor);
            let mut microphone = frame.to_vec();
            processor.process_capture(&mut microphone);
            sent.extend_from_slice(&microphone);
        }
        let input = power(&near[near.len() / 2..]);
        let output = power(&sent[sent.len() / 2..]);
        let change_db = 10.0 * (output / input).log10();
        println!("local speech level change through the processor: {change_db:.1} dB");
        assert!(change_db > -12.0, "local speech lost {change_db:.1} dB");
    }
}
