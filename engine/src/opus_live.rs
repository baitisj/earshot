//! Opus for live listening (`/api/listen?codec=opus`).
//!
//! Each socket that asks for Opus gets its own encoder. Decoded voice and SSB chunks are
//! re-framed into 20 ms Opus packets: a JSON descriptor with `"encoding":"opus"` and the
//! packet's sample count, then the packet as one binary message. Raw FM (`"raw":true`) stays
//! s16le PCM, because the browser keeps it as a lossless capture. Recordings and everything
//! the engine decodes keep using PCM; Opus is only the last hop to a listener.
use serde_json::Value;

/// Sample rates Opus encodes natively.
const RATES: [u32; 5] = [8000, 12000, 16000, 24000, 48000];
/// One packet per 20 ms: the latency Opus adds on top of the chunking the decoders do.
const FRAME_MS: u32 = 20;
/// Largest packet libopus produces for one 20 ms mono frame is far below this.
const MAX_PACKET: usize = 1500;

/// Bit rate for clear speech at each rate (narrowband voice and SSB at 8 kHz: 16 kbit/s).
fn bitrate(rate: u32) -> i32 {
    match rate {
        8000 => 16_000,
        12000 => 20_000,
        16000 => 24_000,
        24000 => 28_000,
        _ => 32_000,
    }
}

pub(crate) struct LiveOpus {
    /// (rate, channel, decoder generation, source generation) the encoder was made for.
    key: Option<(u32, String, String, String)>,
    encoder: Option<opus::Encoder>,
    pending: Vec<i16>,
    /// Samples encoded since the key last changed (so `first_sample` stays meaningful).
    sent: u64,
}

impl LiveOpus {
    pub(crate) fn new() -> Self {
        Self { key: None, encoder: None, pending: Vec::new(), sent: 0 }
    }

    /// Drop buffered samples, e.g. after a gap, so stale audio never plays late.
    pub(crate) fn reset(&mut self) {
        self.pending.clear();
        if let Some(e) = self.encoder.as_mut() {
            let _ = e.reset_state();
        }
    }

    /// Whether this chunk goes out as Opus; anything else passes through as PCM.
    pub(crate) fn takes(meta: &Value) -> bool {
        meta["encoding"] == "s16le"
            && meta["channels"] == 1
            && meta["raw"] != true
            && meta["rate_hz"].as_u64().is_some_and(|r| RATES.contains(&(r as u32)))
    }

    /// One PCM chunk in, zero or more (descriptor, packet) pairs out. Samples short of a
    /// whole frame wait for the next chunk. Errors fall back to PCM for this chunk.
    pub(crate) fn push(&mut self, meta: &Value, pcm: &[u8]) -> Result<Vec<(Value, Vec<u8>)>, String> {
        let rate = meta["rate_hz"].as_u64().unwrap_or(0) as u32;
        let key = (
            rate,
            meta["channel_id"].as_str().unwrap_or("").to_string(),
            meta["generation"].to_string(),
            meta["source_generation"].to_string(),
        );
        if self.key.as_ref() != Some(&key) {
            let mut e = opus::Encoder::new(rate, opus::Channels::Mono, opus::Application::Voip)
                .map_err(|e| format!("opus encoder: {e}"))?;
            e.set_bitrate(opus::Bitrate::Bits(bitrate(rate))).map_err(|e| format!("opus bitrate: {e}"))?;
            self.encoder = Some(e);
            self.key = Some(key);
            self.pending.clear();
            self.sent = 0;
        }
        self.pending.extend(pcm.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])));
        let frame = (rate * FRAME_MS / 1000) as usize;
        let encoder = self.encoder.as_mut().expect("encoder made above");
        let mut out = Vec::new();
        let mut packet = vec![0u8; MAX_PACKET];
        let mut used = 0;
        while self.pending.len() - used >= frame {
            let n = encoder
                .encode(&self.pending[used..used + frame], &mut packet)
                .map_err(|e| format!("opus encode: {e}"))?;
            let mut m = meta.clone();
            m["encoding"] = Value::from("opus");
            m["samples"] = Value::from(frame);
            m["bytes"] = Value::from(n);
            m["frame_ms"] = Value::from(FRAME_MS);
            m["encoded_sample"] = Value::from(self.sent);
            out.push((m, packet[..n].to_vec()));
            self.sent += frame as u64;
            used += frame;
        }
        self.pending.drain(..used);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chunk(rate: u32, n: usize, f: f64) -> (Value, Vec<u8>) {
        let pcm: Vec<u8> = (0..n)
            .flat_map(|i| (((i as f64 * f * 2.0 * std::f64::consts::PI / rate as f64).sin() * 8000.0) as i16).to_le_bytes())
            .collect();
        (json!({"type":"audio","encoding":"s16le","channels":1,"rate_hz":rate,"samples":n,"channel_id":"A-1","generation":1,"source_generation":2,"sequence":0}), pcm)
    }

    #[test]
    fn frames_voice_into_20ms_packets_and_round_trips() {
        let mut live = LiveOpus::new();
        let (meta, pcm) = chunk(8000, 500, 440.0);
        assert!(LiveOpus::takes(&meta));
        let out = live.push(&meta, &pcm).unwrap();
        assert_eq!(out.len(), 3, "500 samples = three 160-sample frames, 20 left over");
        assert_eq!(live.pending.len(), 20);
        for (m, p) in &out {
            assert_eq!(m["encoding"], "opus");
            assert_eq!(m["samples"], 160);
            assert_eq!(m["bytes"], p.len());
            assert!(p.len() < 80, "16 kbit/s is 40 bytes per 20 ms, got {}", p.len());
        }
        let mut dec = opus::Decoder::new(8000, opus::Channels::Mono).unwrap();
        let mut pcm_out = vec![0i16; 160];
        let n = dec.decode(&out[2].1, &mut pcm_out, false).unwrap();
        assert_eq!(n, 160);
        let peak = pcm_out.iter().map(|s| s.unsigned_abs()).max().unwrap();
        assert!(peak > 3000, "a decoded 440 Hz tone, peak {peak}");
    }

    #[test]
    fn raw_fm_and_odd_rates_stay_pcm() {
        let (mut meta, _) = chunk(48000, 960, 1000.0);
        assert!(LiveOpus::takes(&meta));
        meta["raw"] = Value::from(true);
        assert!(!LiveOpus::takes(&meta), "raw FM is a lossless capture");
        let (meta, _) = chunk(44100, 960, 1000.0);
        assert!(!LiveOpus::takes(&meta));
    }

    #[test]
    fn a_new_channel_or_generation_starts_a_fresh_encoder() {
        let mut live = LiveOpus::new();
        let (meta, pcm) = chunk(8000, 170, 300.0);
        live.push(&meta, &pcm).unwrap();
        assert_eq!(live.pending.len(), 10);
        let mut other = meta.clone();
        other["generation"] = Value::from(9);
        let out = live.push(&other, &pcm).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0["encoded_sample"], 0, "counter restarts with the encoder");
        assert_eq!(live.pending.len(), 10, "the old channel's leftover was dropped");
    }
}
