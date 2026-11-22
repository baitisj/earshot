//! Live browser audio as Opus: one encoder per listening socket, 20 ms packets.
//!
//! A JSON descriptor goes out only when the stream changes. Each binary message after it holds
//! one or more packets, each prefixed by its length as a little-endian u16. A descriptor per
//! packet would cost more than the audio.
use serde_json::{Value, json};
use std::ffi::{c_int, c_void};

const OPUS_APPLICATION_VOIP: c_int = 2048;
const OPUS_APPLICATION_AUDIO: c_int = 2049;
const OPUS_SET_BITRATE: c_int = 4002;
const OPUS_SET_MAX_BANDWIDTH: c_int = 4004;
const OPUS_SET_COMPLEXITY: c_int = 4010;
const OPUS_BANDWIDTH_NARROWBAND: c_int = 1101;
const OPUS_BANDWIDTH_WIDEBAND: c_int = 1103;
/// The largest packet asked of the encoder; 20 ms at these bitrates is far smaller.
const MAX_PACKET: usize = 1275;
const FRAMES_PER_SECOND: usize = 50;

unsafe extern "C" {
    fn opus_encoder_create(fs: i32, channels: c_int, application: c_int, error: *mut c_int) -> *mut c_void;
    fn opus_encoder_destroy(state: *mut c_void);
    fn opus_encoder_ctl(state: *mut c_void, request: c_int, ...) -> c_int;
    fn opus_encode(state: *mut c_void, pcm: *const i16, frame_size: c_int, data: *mut u8, max_bytes: i32) -> i32;
}

struct Encoder {
    state: *mut c_void,
    frame: usize,
}
// SAFETY: the libopus state has no thread affinity and `Encoder` owns it exclusively.
unsafe impl Send for Encoder {}

impl Encoder {
    /// 8 kHz is decoded voice or SSB. 48 kHz is the raw discriminator, whose audio stops near
    /// 5.6 kHz, so wideband holds all of it.
    fn new(rate: u32) -> Option<Self> {
        let (application, bitrate, bandwidth) = match rate {
            8000 => (OPUS_APPLICATION_VOIP, 16_000, OPUS_BANDWIDTH_NARROWBAND),
            48000 => (OPUS_APPLICATION_AUDIO, 24_000, OPUS_BANDWIDTH_WIDEBAND),
            _ => return None,
        };
        let mut error = 0;
        // SAFETY: a valid rate and channel count; the pointer is checked before use.
        let state = unsafe { opus_encoder_create(rate as i32, 1, application, &mut error) };
        if state.is_null() || error != 0 {
            return None;
        }
        // SAFETY: `state` is live, and each request takes one opus_int32.
        unsafe {
            opus_encoder_ctl(state, OPUS_SET_BITRATE, bitrate as i32);
            opus_encoder_ctl(state, OPUS_SET_MAX_BANDWIDTH, bandwidth as i32);
            opus_encoder_ctl(state, OPUS_SET_COMPLEXITY, 5i32);
        }
        Some(Self { state, frame: rate as usize / FRAMES_PER_SECOND })
    }

    fn encode(&mut self, pcm: &[i16], out: &mut Vec<u8>) -> bool {
        debug_assert_eq!(pcm.len(), self.frame);
        let mut packet = [0u8; MAX_PACKET];
        // SAFETY: `pcm` holds one frame and `packet` has room for `MAX_PACKET` bytes.
        let written = unsafe { opus_encode(self.state, pcm.as_ptr(), self.frame as c_int, packet.as_mut_ptr(), MAX_PACKET as i32) };
        if written <= 0 {
            return false;
        }
        out.extend_from_slice(&(written as u16).to_le_bytes());
        out.extend_from_slice(&packet[..written as usize]);
        true
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        // SAFETY: created by opus_encoder_create and destroyed once.
        unsafe { opus_encoder_destroy(self.state) }
    }
}

/// What to send a listener for one chunk of audio.
pub struct Outgoing {
    pub descriptor: Option<String>,
    pub packets: Vec<u8>,
}

/// One socket's encoder, rebuilt whenever the channel, decoder or sample rate changes.
#[derive(Default)]
pub struct LiveOpus {
    key: Option<[Value; 5]>,
    encoder: Option<Encoder>,
    pending: Vec<i16>,
    fresh: bool,
}

impl LiveOpus {
    /// Encode a chunk of s16le audio. `None` means this rate has no encoder: send it as PCM.
    pub fn push(&mut self, meta: &Value, pcm: &[u8]) -> Option<Outgoing> {
        let key = ["channel_id", "generation", "source_generation", "rate_hz", "raw"].map(|k| meta[k].clone());
        let mut descriptor = None;
        if self.key.as_ref() != Some(&key) {
            self.encoder = Encoder::new(meta["rate_hz"].as_u64()? as u32);
            self.pending.clear();
            self.key = self.encoder.is_some().then(|| key.clone());
            self.encoder.as_ref()?;
            descriptor = Some(
                json!({"type":"opus","channels":1,"frame_ms":20,"rate_hz":key[3],"channel_id":key[0],
                    "generation":key[1],"source_generation":key[2],"raw":meta["raw"].as_bool().unwrap_or(false)})
                .to_string(),
            );
        }
        let encoder = self.encoder.as_mut()?;
        self.fresh = true;
        self.pending.extend(pcm.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])));
        let mut packets = Vec::new();
        let frames = self.pending.len() / encoder.frame;
        for index in 0..frames {
            let start = index * encoder.frame;
            if !encoder.encode(&self.pending[start..start + encoder.frame], &mut packets) {
                break;
            }
        }
        self.pending.drain(..frames * encoder.frame);
        Some(Outgoing { descriptor, packets })
    }

    /// Audio was lost: a partial frame no longer joins what comes next.
    pub fn gap(&mut self) {
        self.pending.clear();
    }

    /// Called twice a second. A partial frame left after a quiet interval is the tail of an
    /// over, under 20 ms of it; drop it so it doesn't splice onto the next one.
    pub fn tick(&mut self) {
        if !std::mem::take(&mut self.fresh) {
            self.pending.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    unsafe extern "C" {
        fn opus_decoder_create(fs: i32, channels: c_int, error: *mut c_int) -> *mut c_void;
        fn opus_decoder_destroy(state: *mut c_void);
        fn opus_decode(state: *mut c_void, data: *const u8, len: i32, pcm: *mut i16, frame_size: c_int, fec: c_int) -> c_int;
    }

    fn meta(rate: u32, channel: &str) -> Value {
        json!({"channel_id":channel,"generation":1,"source_generation":2,"rate_hz":rate,"raw":true})
    }

    fn tone(rate: u32, hz: f64, n: usize) -> Vec<u8> {
        (0..n)
            .flat_map(|i| (((i as f64 * hz * std::f64::consts::TAU / rate as f64).sin() * 12000.) as i16).to_le_bytes())
            .collect()
    }

    fn packets(mut bytes: &[u8]) -> Vec<&[u8]> {
        let mut out = Vec::new();
        while bytes.len() >= 2 {
            let n = u16::from_le_bytes([bytes[0], bytes[1]]) as usize;
            out.push(&bytes[2..2 + n]);
            bytes = &bytes[2 + n..];
        }
        out
    }

    /// Level of `hz` in the decoded audio, relative to full scale, past the codec's start-up.
    fn decoded_level(stream: &[u8], hz: f64) -> f64 {
        let mut error = 0;
        // SAFETY: test-only use of a live decoder with a buffer sized for 120 ms.
        let pcm = unsafe {
            let decoder = opus_decoder_create(48000, 1, &mut error);
            assert!(!decoder.is_null());
            let mut all = Vec::new();
            for packet in packets(stream) {
                let mut frame = [0i16; 5760];
                let n = opus_decode(decoder, packet.as_ptr(), packet.len() as i32, frame.as_mut_ptr(), 5760, 0);
                assert_eq!(n, 960);
                all.extend_from_slice(&frame[..n as usize]);
            }
            opus_decoder_destroy(decoder);
            all
        };
        let body = &pcm[pcm.len() / 4..];
        let (mut re, mut im) = (0., 0.);
        for (i, v) in body.iter().enumerate() {
            let phase = i as f64 * hz * std::f64::consts::TAU / 48000.;
            re += *v as f64 * phase.cos();
            im += *v as f64 * phase.sin();
        }
        2. * (re * re + im * im).sqrt() / body.len() as f64 / 32768.
    }

    #[test]
    fn narrowband_voice_stays_near_its_bitrate_and_decodes() {
        let mut live = LiveOpus::default();
        let audio = tone(8000, 700., 8000);
        let mut stream = Vec::new();
        let mut descriptors = 0;
        // Odd chunk sizes: the encoder must carry the partial frame.
        for chunk in audio.chunks(2 * 137) {
            let out = live.push(&meta(8000, "A"), chunk).unwrap();
            descriptors += out.descriptor.is_some() as u32;
            stream.extend(out.packets);
        }
        assert_eq!(descriptors, 1);
        assert_eq!(packets(&stream).len(), 50);
        assert!(stream.len() * 8 < 20_000, "{} bit/s", stream.len() * 8);
        assert!(decoded_level(&stream, 700.) > 0.2);
    }

    #[test]
    fn raw_discriminator_rate_is_encoded_wideband() {
        let mut live = LiveOpus::default();
        let out = live.push(&meta(48000, "A"), &tone(48000, 3000., 48000)).unwrap();
        assert_eq!(packets(&out.packets).len(), 50);
        assert!(decoded_level(&out.packets, 3000.) > 0.2);
    }

    #[test]
    fn a_new_channel_restarts_the_stream_and_other_rates_stay_pcm() {
        let mut live = LiveOpus::default();
        assert!(live.push(&meta(8000, "A"), &tone(8000, 500., 100)).unwrap().descriptor.is_some());
        assert!(live.push(&meta(8000, "A"), &tone(8000, 500., 100)).unwrap().descriptor.is_none());
        let changed = live.push(&meta(8000, "B"), &tone(8000, 500., 100)).unwrap();
        assert!(changed.descriptor.unwrap().contains("\"channel_id\":\"B\""));
        assert!(changed.packets.is_empty(), "the old channel's partial frame must not carry over");
        assert!(live.push(&meta(11025, "B"), &tone(11025, 500., 100)).is_none());
    }

    #[test]
    fn a_stale_partial_frame_is_dropped_after_a_quiet_tick() {
        let mut live = LiveOpus::default();
        live.push(&meta(8000, "A"), &tone(8000, 500., 100)).unwrap();
        live.tick();
        assert_eq!(live.pending.len(), 100);
        live.tick();
        assert!(live.pending.is_empty());
    }
}
