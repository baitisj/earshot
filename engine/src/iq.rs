//! Bounded, pre-demodulation snapshots of the physical IQ slices listeners pin.
use crate::{dsp::fft, freq::Calibration, wire::{Frame, DISCONTINUITY, OVERFLOW, PREROLL, START}};
use serde_json::{json, Value};
use num_complex::Complex32;
use std::{collections::{HashMap, VecDeque}, io, sync::Arc};

const MAX_BYTES: usize = 32 * 1024 * 1024;
const SECONDS: f64 = 30.;
/// Fine spectrum size: 1024 points at 100 ksps is 97.7 Hz per bin.
pub const FINE_BINS: usize = 1024;
pub const FINE_LOW_DB: f32 = -160.;
pub const FINE_HIGH_DB: f32 = 0.;

#[derive(Clone)]
struct Packet { frame: Arc<Frame>, received: f64 }
#[derive(Default)]
struct Slice { packets: VecDeque<Packet>, rate: f64 }
#[derive(Default)]
pub(crate) struct IqHistory { slices: HashMap<u32, Slice>, bytes: usize }

impl IqHistory {
    pub fn push(&mut self, mut frame: Arc<Frame>, rate: f64, received: f64) {
        if frame.flags & PREROLL != 0 || frame.payload.is_empty() { return; }
        let slice = self.slices.entry(frame.stream_id).or_default();
        if slice.packets.back().is_some_and(|last| {
            let f = &last.frame;
            f.generation != frame.generation || f.center_hz != frame.center_hz ||
                f.rate != frame.rate || f.valid_bits != frame.valid_bits || slice.rate != rate
        }) {
            self.bytes -= slice.packets.iter().map(|p| p.frame.payload.len()).sum::<usize>();
            slice.packets.clear();
        }
        slice.rate = rate;
        // Pin pre-roll can overlap delivered data. Keep each sample once.
        if let Some(last) = slice.packets.back() {
            let expected = last.frame.first_sample + last.frame.payload.len() as u64 / 4;
            if frame.first_sample < expected {
                let trim = ((expected - frame.first_sample) as usize).min(frame.payload.len() / 4);
                if trim == frame.payload.len() / 4 { return; }
                let f = Arc::make_mut(&mut frame);
                f.payload.drain(..trim * 4);
                f.first_sample += trim as u64;
            }
        }
        let cutoff = (frame.first_sample + frame.payload.len() as u64 / 4).saturating_sub((rate * SECONDS) as u64);
        while slice.packets.front().is_some_and(|p| p.frame.first_sample < cutoff) {
            self.bytes -= slice.packets.pop_front().unwrap().frame.payload.len();
        }
        self.bytes += frame.payload.len();
        slice.packets.push_back(Packet { frame, received });
        while self.bytes > MAX_BYTES {
            let oldest = self.slices.iter().filter_map(|(id, s)| s.packets.front().map(|p| (*id, p.received)))
                .min_by(|a, b| a.1.total_cmp(&b.1)).map(|x| x.0).unwrap();
            self.bytes -= self.slices.get_mut(&oldest).unwrap().packets.pop_front().unwrap().frame.payload.len();
        }
        self.slices.retain(|_, s| !s.packets.is_empty());
    }
    pub fn snapshot(&self, stream: u32) -> Option<IqSnapshot> {
        let slice = self.slices.get(&stream)?;
        Some(IqSnapshot { packets: slice.packets.iter().cloned().collect(), rate: slice.rate })
    }
}

pub(crate) struct IqSnapshot { packets: Vec<Packet>, rate: f64 }
impl IqSnapshot {
    /// Fine spectrum of this slice at the given moments (PSD sequence, host arrival time),
    /// for the waterfall's lens: one row per moment that has IQ received within 0.5 s
    /// before it. Each row averages Hann-windowed `FINE_BINS`-point FFTs (50 % overlap)
    /// over the IQ that arrived since the previous moment (at most 8 windows), lowest
    /// frequency first, dB relative to a full-scale complex tone, quantized from
    /// `FINE_LOW_DB` (1) to `FINE_HIGH_DB` (255). Level 0 never occurs, so a client can
    /// use it for "no fine data". The first moment only sets the spacing of the next.
    pub fn fine_rows(&self, moments: &[(u64, f64)]) -> Vec<(u64, Vec<u8>)> {
        const N: usize = FINE_BINS;
        let mut ends = Vec::with_capacity(self.packets.len());
        let mut total = 0usize;
        for p in &self.packets {
            total += p.frame.payload.len() / 4;
            ends.push((p.received, total));
        }
        let full_scale = 2f32.powi(self.packets.first().map_or(15, |p| p.frame.valid_bits.clamp(2, 16) as i32 - 1));
        let window: Vec<f32> = (0..N).map(|i| 0.5 - 0.5 * (2. * std::f32::consts::PI * i as f32 / N as f32).cos()).collect();
        let gain: f32 = window.iter().sum::<f32>() * full_scale;
        let mut rows = vec![];
        for pair in moments.windows(2) {
            let ((_, before), (seq, at)) = (pair[0], pair[1]);
            let last = ends.partition_point(|(received, _)| *received <= at);
            if last == 0 || at - ends[last - 1].0 > 0.5 { continue; }
            let end = ends[last - 1].1;
            let wanted = (((at - before).max(0.) * self.rate) as usize).clamp(N, 8 * N);
            let windows = 1 + (wanted - N) / (N / 2);
            let span = N + (windows - 1) * (N / 2);
            if end < span { continue; }
            let samples = self.samples_between(end - span, end);
            let mut power = vec![0f32; N];
            let mut buffer = vec![Complex32::new(0., 0.); N];
            for w in 0..windows {
                let segment = &samples[w * N / 2..w * N / 2 + N];
                for ((b, x), h) in buffer.iter_mut().zip(segment).zip(&window) { *b = x * *h; }
                fft(&mut buffer);
                for (p, b) in power.iter_mut().zip(&buffer) { *p += b.norm_sqr(); }
            }
            let scale = 1. / (windows as f32 * gain * gain);
            let row = (0..N).map(|k| {
                let db = 10. * (power[(k + N / 2) % N] * scale).max(1e-30).log10();
                (1. + 254. * (db - FINE_LOW_DB) / (FINE_HIGH_DB - FINE_LOW_DB)).round().clamp(1., 255.) as u8
            }).collect();
            rows.push((seq, row));
        }
        rows
    }
    /// Samples `[from, to)` counted from the first retained one, as full-scale-free floats.
    fn samples_between(&self, from: usize, to: usize) -> Vec<Complex32> {
        let mut out = Vec::with_capacity(to - from);
        let mut at = 0usize;
        for p in &self.packets {
            let count = p.frame.payload.len() / 4;
            if at + count > from && at < to {
                let skip = from.saturating_sub(at);
                let take = (to - at).min(count) - skip;
                out.extend(p.frame.payload[skip * 4..(skip + take) * 4].chunks_exact(4).map(|b|
                    Complex32::new(i16::from_le_bytes([b[0], b[1]]) as f32, i16::from_le_bytes([b[2], b[3]]) as f32)));
            }
            at += count;
            if at >= to { break; }
        }
        out
    }
    pub fn rate(&self) -> f64 { self.rate }
    pub fn center_reading_hz(&self) -> f64 { self.packets[0].frame.center_hz as f64 }
    fn samples(&self) -> usize { self.packets.iter().map(|p| p.frame.payload.len() / 4).sum() }
    pub fn status(&self, cal: Calibration) -> Value {
        let first = &self.packets[0].frame;
        json!({"samples":self.samples(),"seconds":self.samples() as f64 / self.rate,
            "sample_rate_hz":self.rate,"center_hz":cal.true_hz(first.center_hz as f64),
            "stream_id":first.stream_id,"max_seconds":SECONDS,"last_received_at":self.packets.last().unwrap().received})
    }
    pub fn archive(&self, target_hz: f64, cal: Calibration) -> io::Result<Vec<u8>> {
        let first = &self.packets[0].frame;
        let center = cal.true_hz(first.center_hz as f64);
        let mut captures = vec![];
        let mut annotations = vec![];
        let mut offset = 0u64;
        let mut expected = None;
        for packet in &self.packets {
            let f = &packet.frame;
            if expected != Some(f.first_sample) || f.flags & (DISCONTINUITY | OVERFLOW | START) != 0 {
                captures.push(json!({"core:sample_start":offset,"core:global_index":f.first_sample,"core:frequency":center}));
                if offset > 0 {
                    annotations.push(json!({"core:sample_start":offset,"core:sample_count":0,
                        "core:label":"discontinuity","core:comment":format!("RIQ1 flags {}; expected source sample {:?}, received {}", f.flags, expected, f.first_sample)}));
                }
            }
            offset += f.payload.len() as u64 / 4;
            expected = Some(f.first_sample + f.payload.len() as u64 / 4);
        }
        let meta = json!({"global":{"core:datatype":"ci16_le","core:sample_rate":self.rate,
            "core:version":"1.2.6","core:recorder":"amateur-radio",
            "core:description":format!("Channelized physical IQ slice, not full-band IQ. Selected target {target_hz} Hz; physical center {center} Hz; {} valid bits. No host channel filtering, FM demodulation, squelch or voice processing. Transport sample counters retained; ADC continuity unknown. Gaps are not zero-filled.", first.valid_bits)},
            "captures":captures,"annotations":annotations});
        let provenance = json!({"calibration_ppm":cal.ppm,"target_hz":target_hz,"packets":self.packets.iter().map(|p| {
            let f = &p.frame;
            json!({"source_generation":f.generation,"stream_id":f.stream_id,"sequence":f.sequence,
                "first_sample":f.first_sample,"samples":f.payload.len()/4,"flags":f.flags,
                "center_reading_hz":f.center_hz,"valid_bits":f.valid_bits,"host_received_at":p.received})
        }).collect::<Vec<_>>()});
        let samples: Vec<u8> = self.packets.iter().flat_map(|p| p.frame.payload.iter().copied()).collect();
        let mut tar = tar::Builder::new(Vec::new());
        for (name, bytes) in [("capture.sigmf-meta", serde_json::to_vec_pretty(&meta)?),
            ("capture.sigmf-data", samples), ("packets.json", serde_json::to_vec(&provenance)?)] {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64); header.set_mode(0o644); header.set_cksum();
            tar.append_data(&mut header, name, bytes.as_slice())?;
        }
        tar.into_inner()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    fn packet(sample: u64, generation: u64) -> Arc<Frame> {
        Arc::new(Frame { kind:1,flags:0,generation,stream_id:7,sequence:sample,first_sample:sample,
            rate:100000,center_hz:454000000,format:1,valid_bits:16,payload:vec![1,2,3,4,5,6,7,8] })
    }
    #[test]
    fn iq_archive_preserves_complex_samples_and_marks_gaps_without_filling_them() {
        let mut history = IqHistory::default();
        history.push(packet(100, 1), 100000., 1.);
        history.push(packet(105, 1), 100000., 2.);
        let snapshot = history.snapshot(7).unwrap();
        assert_eq!(snapshot.status(Calibration{ppm:0.})["samples"], 4);
        let archive = snapshot.archive(454001000., Calibration{ppm:0.}).unwrap();
        let mut files = HashMap::new();
        for entry in tar::Archive::new(archive.as_slice()).entries().unwrap() {
            let mut entry = entry.unwrap();
            let name = entry.path().unwrap().to_string_lossy().into_owned();
            let mut bytes = Vec::new(); entry.read_to_end(&mut bytes).unwrap(); files.insert(name, bytes);
        }
        assert_eq!(files["capture.sigmf-data"], [packet(100,1).payload.clone(), packet(105,1).payload.clone()].concat());
        let meta: Value = serde_json::from_slice(&files["capture.sigmf-meta"]).unwrap();
        assert_eq!(meta["global"]["core:datatype"], "ci16_le");
        assert_eq!(meta["global"]["core:sample_rate"], 100000.);
        assert_eq!(meta["captures"][1]["core:sample_start"], 2);
        assert_eq!(meta["captures"][1]["core:global_index"], 105);
        assert_eq!(meta["annotations"][0]["core:label"], "discontinuity");
    }
    #[test]
    fn fine_rows_put_a_tone_in_its_bin_and_skip_moments_without_iq() {
        let mut h = IqHistory::default();
        let rate = 100000.;
        let tone = 10_000.;
        let mut sample = 0u64;
        for packet in 0..40u64 {
            let payload: Vec<u8> = (0..1000).flat_map(|i| {
                let phase = 2. * std::f64::consts::PI * tone * (sample + i) as f64 / rate;
                let (q, i_) = ((8000. * phase.sin()) as i16, (8000. * phase.cos()) as i16);
                [i_.to_le_bytes(), q.to_le_bytes()].concat()
            }).collect();
            h.push(Arc::new(Frame { kind:1,flags:0,generation:1,stream_id:7,sequence:packet,first_sample:sample,
                rate:100000,center_hz:454000000,format:1,valid_bits:16,payload }), rate, 100. + packet as f64 * 0.01);
            sample += 1000;
        }
        let rows = h.snapshot(7).unwrap().fine_rows(&[(1, 100.2), (2, 100.3), (3, 100.39), (4, 101.5)]);
        assert_eq!(rows.iter().map(|r| r.0).collect::<Vec<_>>(), [2, 3], "moment 4 has no IQ within 0.5 s");
        let row = &rows[0].1;
        let peak = (0..FINE_BINS).max_by_key(|&k| row[k]).unwrap();
        let expected = FINE_BINS / 2 + (tone / (rate / FINE_BINS as f64)).round() as usize;
        assert!(peak.abs_diff(expected) <= 1, "peak {peak} expected {expected}");
        // 8000 of 32768 full scale is -12.2 dB.
        let db = FINE_LOW_DB + (row[peak] as f32 - 1.) / 254. * (FINE_HIGH_DB - FINE_LOW_DB);
        assert!((db + 12.2).abs() < 2., "tone level {db} dB");
        assert!(row.iter().all(|&v| v >= 1));
    }
    #[test]
    fn reset_overlap_and_preroll_cannot_mix_iq_epochs() {
        let mut h = IqHistory::default();
        h.push(packet(100,1), 100000., 1.);
        h.push(packet(100,1), 100000., 2.); // overlap
        assert_eq!(h.snapshot(7).unwrap().samples(), 2);
        h.push(packet(101,1), 100000., 2.5); // partial overlap keeps the new tail
        assert_eq!(h.snapshot(7).unwrap().samples(), 3);
        h.push(packet(0,2), 100000., 3.);
        assert_eq!(h.snapshot(7).unwrap().samples(), 2);
        let mut pre = (*packet(2,2)).clone(); pre.flags = PREROLL;
        h.push(Arc::new(pre), 100000., 4.);
        assert_eq!(h.snapshot(7).unwrap().samples(), 2);
    }
    #[test]
    fn history_is_bounded_by_time_and_a_global_byte_budget() {
        let mut h = IqHistory::default();
        h.push(packet(0,1), 100000., 1.);
        h.push(packet(4000000,1), 100000., 2.);
        assert_eq!(h.snapshot(7).unwrap().samples(), 2);
        for stream in 1..=16 {
            for n in 0..60 {
                let mut p = (*packet(n * 10000,1)).clone(); p.stream_id=stream; p.payload=vec![0;40000];
                h.push(Arc::new(p),100000.,(stream * 100+n as u32) as f64);
            }
        }
        assert!(h.bytes <= MAX_BYTES);
        assert_eq!(h.snapshot(16).unwrap().samples(), 600000);
    }
}
