//! Single-sideband (USB/LSB) receive path for a coarse complex IQ slice.
//!
//! The FPGA channelizer delivers 100 ksps complex slices whose passband is flat to
//! +-31.25 kHz of the bin centre, and every frequency is within 25 kHz of some bin
//! centre, so a 3 kHz SSB channel always fits inside one slice: SSB needs no FPGA
//! change, only a host demodulator.
//!
//! Method (the "phasing-free" complex-baseband SSB receiver; Weaver 1956 is the
//! analog ancestor): mix the centre of the wanted audio passband (dial +- 1.5 kHz)
//! to 0 Hz, low-pass the complex signal to +-`half_band`, which keeps only the
//! wanted sideband, then mix back up by +-1.5 kHz at the audio rate and take the
//! real part. The opposite sideband lands at -(1.5 kHz + a) and is removed by the
//! low-pass, so its rejection is the filter's stopband (70 dB) for audio above
//! `centre - stop` (about 250 Hz with the default band).
//!
//! Decimation runs in two stages with the engine's Kaiser resampler (see
//! DESIGN-DSP.md): a cheap 100k -> 20k stage whose aliases fold outside the final
//! passband, then the sharp sideband filter at 20 kHz down to the audio rate
//! (12 kHz for FT8/WSPR decoders, 8 kHz for browser audio).
use crate::dsp::{ChannelSpec, Resampler};
use num_complex::Complex32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sideband {
    Upper,
    Lower,
}
impl Sideband {
    /// Channel protocol names used by the engine: `USB` and `LSB`.
    pub fn from_protocol(protocol: &str) -> Option<Self> {
        match protocol {
            "USB" => Some(Self::Upper),
            "LSB" => Some(Self::Lower),
            _ => None,
        }
    }
    pub fn protocol(self) -> &'static str {
        match self {
            Self::Upper => "USB",
            Self::Lower => "LSB",
        }
    }
    /// Lower-case name for API payloads (`usb`, `lsb`).
    pub fn name(self) -> &'static str {
        match self {
            Self::Upper => "usb",
            Self::Lower => "lsb",
        }
    }
}

/// Audio passband of an SSB channel, Hz above (USB) or below (LSB) the dial.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SsbBand {
    /// Centre of the audio passband (Hz from the dial).
    pub centre_hz: f64,
    /// Flat half-width around the centre.
    pub half_band_hz: f64,
    /// Half-width where 70 dB rejection starts.
    pub half_stop_hz: f64,
}
impl SsbBand {
    /// Voice and FT8: about 100 to 2900 Hz flat, 70 dB below 250 Hz into the other
    /// sideband. FT8 signals sit 200 to 3000 Hz above the dial (WSJT-X default).
    pub const WIDE: Self = Self { centre_hz: 1500., half_band_hz: 1450., half_stop_hz: 1750. };
    /// WSPR: the 200 Hz sub-band 1400 to 1600 Hz above the dial, with margin for
    /// a +-150 Hz calibration error (wsprd -w searches +-150 Hz).
    pub const WSPR: Self = Self { centre_hz: 1500., half_band_hz: 400., half_stop_hz: 700. };
}

pub struct SsbDemod {
    sideband: Sideband,
    band: SsbBand,
    input_rate: f64,
    output_rate: f64,
    /// Dial offset from the slice centre, Hz (reading frame).
    offset_hz: f64,
    /// Live LO correction from the reference tracker, Hz (added to the offset).
    correction_hz: f64,
    phase_in: f64,
    phase_out: f64,
    stage1: Resampler,
    stage2: Resampler,
}

const MID_RATE: f64 = 20000.;

impl SsbDemod {
    /// `offset_hz` is dial frequency minus slice centre; `output_rate` is the audio rate.
    pub fn new(input_rate: f64, offset_hz: f64, sideband: Sideband, band: SsbBand, output_rate: f64) -> Self {
        assert!(output_rate / 2. > band.centre_hz + band.half_band_hz, "audio rate too low for the band");
        // Stage 1: protect +-half_stop from aliases. Content between `stop1` and
        // MID_RATE - half_stop folds outside the final passband, where stage 2 removes it.
        let stop1 = (MID_RATE - band.half_stop_hz).min(input_rate / 2. - 1.);
        let stage1 = Resampler::new(
            input_rate,
            MID_RATE,
            ChannelSpec { pass_hz: band.half_stop_hz, stop_hz: stop1, atten_db: 80., band_hz: 2. * band.half_band_hz },
        );
        let stage2 = Resampler::new(
            MID_RATE,
            output_rate,
            ChannelSpec { pass_hz: band.half_band_hz, stop_hz: band.half_stop_hz, atten_db: 70., band_hz: 2. * band.half_band_hz },
        );
        Self { sideband, band, input_rate, output_rate, offset_hz, correction_hz: 0., phase_in: 0., phase_out: 0., stage1, stage2 }
    }

    /// Set the live LO correction (Hz, same sign convention as the offset: a radio
    /// reading high by `x` Hz at this frequency needs `-x`). Phase-continuous.
    pub fn set_correction_hz(&mut self, hz: f64) {
        self.correction_hz = hz;
    }

    fn mix_hz(&self) -> f64 {
        let centre = match self.sideband {
            Sideband::Upper => self.band.centre_hz,
            Sideband::Lower => -self.band.centre_hz,
        };
        self.offset_hz + self.correction_hz + centre
    }

    /// Complex IQ in, real audio out (float, unity scale, no AGC: decoders want it raw).
    pub fn push(&mut self, iq: &[Complex32]) -> Vec<f32> {
        let step = -2. * std::f64::consts::PI * self.mix_hz() / self.input_rate;
        let mixed: Vec<Complex32> = iq
            .iter()
            .map(|x| {
                let y = *x * Complex32::from_polar(1., self.phase_in as f32);
                self.phase_in = (self.phase_in + step).rem_euclid(2. * std::f64::consts::PI);
                y
            })
            .collect();
        let mid = self.stage1.push(&mixed);
        let base = self.stage2.push(&mid);
        let up = match self.sideband {
            Sideband::Upper => self.band.centre_hz,
            Sideband::Lower => -self.band.centre_hz,
        };
        let step_out = 2. * std::f64::consts::PI * up / self.output_rate;
        base.iter()
            .map(|z| {
                let y = (*z * Complex32::from_polar(1., self.phase_out as f32)).re;
                self.phase_out = (self.phase_out + step_out).rem_euclid(2. * std::f64::consts::PI);
                y
            })
            .collect()
    }
}

/// Slow AGC for listening (attack 10 ms, decay 500 ms), to signed16 at -12 dBFS rms.
pub struct Agc {
    level: f32,
    attack: f32,
    decay: f32,
}
impl Agc {
    pub fn new(rate: f64) -> Self {
        Self {
            level: 1e-4,
            attack: (-1. / (0.010 * rate)).exp() as f32,
            decay: (-1. / (0.500 * rate)).exp() as f32,
        }
    }
    pub fn push(&mut self, audio: &[f32]) -> Vec<i16> {
        audio
            .iter()
            .map(|&x| {
                let a = x.abs();
                let k = if a > self.level { self.attack } else { self.decay };
                self.level = k * self.level + (1. - k) * a;
                (x / self.level.max(1e-6) * 8192.).clamp(-32768., 32767.) as i16
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f64 = 100000.;

    fn tone(f: f64, n: usize, amp: f32) -> Vec<Complex32> {
        (0..n).map(|i| Complex32::from_polar(amp, (2. * std::f64::consts::PI * f * i as f64 / FS) as f32)).collect()
    }

    /// Power (dB) of `audio` at `f` via a single-bin DFT, after the filter settles.
    fn level_db(audio: &[f32], rate: f64, f: f64) -> f64 {
        let a = &audio[audio.len() / 2..];
        let (mut re, mut im) = (0f64, 0f64);
        for (i, &x) in a.iter().enumerate() {
            let p = 2. * std::f64::consts::PI * f * i as f64 / rate;
            re += x as f64 * p.cos();
            im -= x as f64 * p.sin();
        }
        let amp = 2. * (re * re + im * im).sqrt() / a.len() as f64;
        20. * amp.max(1e-12).log10()
    }

    fn run(dial_off: f64, sb: Sideband, band: SsbBand, rf_off: f64, rate: f64) -> Vec<f32> {
        let mut d = SsbDemod::new(FS, dial_off, sb, band, rate);
        let x = tone(rf_off, 100000, 1.);
        // Feed in 10 ms packets like the FPGA producer.
        x.chunks(1000).flat_map(|c| d.push(c)).collect()
    }

    #[test]
    fn usb_tone_lands_at_its_audio_frequency_anywhere_in_the_bin() {
        // Dial at the worst place: 25 kHz from the bin centre, audio up to 28 kHz.
        for dial in [-25000., -12345., 0., 9000., 25000.] {
            for audio in [300., 1500., 2800.] {
                let out = run(dial, Sideband::Upper, SsbBand::WIDE, dial + audio, 12000.);
                let l = level_db(&out, 12000., audio);
                assert!((l - 0.).abs() < 0.1, "dial {dial} audio {audio}: {l} dB");
            }
        }
    }

    #[test]
    fn opposite_sideband_is_rejected_by_70_db() {
        for audio in [400., 1500., 2800.] {
            let out = run(5000., Sideband::Upper, SsbBand::WIDE, 5000. - audio, 12000.);
            let l = level_db(&out, 12000., audio);
            assert!(l < -69., "LSB image at {audio}: {l} dB");
        }
    }

    #[test]
    fn lsb_is_the_mirror_of_usb() {
        let out = run(-7000., Sideband::Lower, SsbBand::WIDE, -7000. - 1000., 8000.);
        assert!(level_db(&out, 8000., 1000.).abs() < 0.1);
        let img = run(-7000., Sideband::Lower, SsbBand::WIDE, -7000. + 1000., 8000.);
        assert!(level_db(&img, 8000., 1000.) < -69.);
    }

    #[test]
    fn neighbour_outside_the_channel_is_rejected() {
        // A strong carrier 4 kHz above the dial (outside 3 kHz USB) must vanish.
        let out = run(0., Sideband::Upper, SsbBand::WIDE, 4000., 12000.);
        let rms = (out[out.len() / 2..].iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / (out.len() / 2) as f64).sqrt();
        assert!(20. * rms.log10() < -65., "{}", 20. * rms.log10());
    }

    #[test]
    fn wspr_band_passes_1500_and_its_cal_margin() {
        for audio in [1350., 1500., 1650.] {
            let out = run(2000., Sideband::Upper, SsbBand::WSPR, 2000. + audio, 12000.);
            assert!(level_db(&out, 12000., audio).abs() < 0.1, "{audio}");
        }
        let out = run(2000., Sideband::Upper, SsbBand::WSPR, 2000. + 400., 12000.);
        assert!(level_db(&out, 12000., 400.) < -69.);
    }

    #[test]
    fn correction_moves_the_tone_by_the_same_hz() {
        let mut d = SsbDemod::new(FS, 0., Sideband::Upper, SsbBand::WIDE, 12000.);
        d.set_correction_hz(37.);
        let x = tone(1537., 100000, 1.);
        let out: Vec<f32> = x.chunks(1000).flat_map(|c| d.push(c)).collect();
        assert!(level_db(&out, 12000., 1500.).abs() < 0.1);
    }

    #[test]
    fn output_rate_is_exact() {
        let out = run(0., Sideband::Upper, SsbBand::WIDE, 1000., 12000.);
        // 1 s in; the resamplers' group delay holds back a few ms.
        assert!((11800..=12000).contains(&out.len()), "{}", out.len());
    }
}
