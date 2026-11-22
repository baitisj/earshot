//! The raw FM discriminator of recently heard channels, kept lossless on the engine.
//!
//! Live audio to the browser is Opus, which is lossy, so "Save audio" fetches from here. Each
//! channel keeps its newest two minutes, and at most `MAX_CHANNELS` channels are kept.
use std::collections::{HashMap, VecDeque};

pub const RATE: u32 = 48000;
const MAX_SECONDS: usize = 120;
const MAX_CHANNELS: usize = 4;
/// Input samples of slack before a jump in `first_sample` counts as a gap.
const INPUT_SLACK: f64 = 2.;

#[derive(Default)]
struct Capture {
    samples: VecDeque<i16>,
    dropped: u64,
    gaps: Vec<(u64, &'static str)>,
    stream: Option<(u64, u64)>,
    expected_input: Option<f64>,
    used: u64,
}

impl Capture {
    fn gap(&mut self, reason: &'static str) {
        let at = self.dropped + self.samples.len() as u64;
        if !self.samples.is_empty() && self.gaps.last().map(|g| g.0) != Some(at) {
            self.gaps.push((at, reason));
        }
    }

    fn push(&mut self, pcm: &[i16], stream: (u64, u64), first_sample: u64, input_rate: u32) {
        if self.stream.is_some_and(|s| s != stream) {
            self.gap("source or decoder restart");
            self.expected_input = None;
        }
        self.stream = Some(stream);
        let first = first_sample as f64;
        if self.expected_input.is_some_and(|expected| (first - expected).abs() > INPUT_SLACK) {
            self.gap("input sample discontinuity");
        }
        self.expected_input = Some(first + pcm.len() as f64 / RATE as f64 * input_rate as f64);
        self.samples.extend(pcm);
        let limit = RATE as usize * MAX_SECONDS;
        if self.samples.len() > limit {
            let excess = self.samples.len() - limit;
            self.samples.drain(..excess);
            self.dropped += excess as u64;
            let dropped = self.dropped;
            self.gaps.retain(|gap| gap.0 >= dropped);
        }
    }
}

/// A copy of a capture's newest audio. Gap positions count from its first sample.
pub struct Snapshot {
    pub samples: Vec<i16>,
    pub gaps: Vec<(u64, &'static str)>,
}

#[derive(Default)]
pub struct Captures {
    channels: HashMap<String, Capture>,
    clock: u64,
}

impl Captures {
    pub(crate) fn push(&mut self, id: &str, pcm: &[i16], stream: (u64, u64), first_sample: u64, input_rate: u32) {
        self.clock += 1;
        if !self.channels.contains_key(id) {
            if self.channels.len() >= MAX_CHANNELS
                && let Some(oldest) = self.channels.iter().min_by_key(|(_, c)| c.used).map(|(k, _)| k.clone())
            {
                self.channels.remove(&oldest);
            }
            self.channels.insert(id.to_string(), Capture::default());
        }
        let capture = self.channels.get_mut(id).expect("inserted above");
        capture.used = self.clock;
        capture.push(pcm, stream, first_sample, input_rate);
    }

    /// The newest `seconds` of a channel (all of it when `None`).
    pub fn snapshot(&self, id: &str, seconds: Option<f64>) -> Option<Snapshot> {
        let capture = self.channels.get(id)?;
        let held = capture.samples.len();
        let wanted = seconds
            .filter(|s| s.is_finite() && *s > 0.)
            .map_or(held, |s| ((s * RATE as f64).ceil() as usize).min(held));
        if wanted == 0 {
            return None;
        }
        let skip = held - wanted;
        let start = capture.dropped + skip as u64;
        Some(Snapshot {
            samples: capture.samples.iter().skip(skip).copied().collect(),
            gaps: capture.gaps.iter().filter(|g| g.0 >= start).map(|g| (g.0 - start, g.1)).collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INPUT: u32 = 96000;

    fn feed(c: &mut Captures, id: &str, n: usize, stream: (u64, u64), first: u64) {
        c.push(id, &vec![7; n], stream, first, INPUT);
    }

    #[test]
    fn a_continuous_stream_has_no_gaps_and_the_tail_is_exact() {
        let mut c = Captures::default();
        feed(&mut c, "A", 4800, (1, 1), 0);
        feed(&mut c, "A", 4800, (1, 1), 9600);
        let all = c.snapshot("A", None).unwrap();
        assert_eq!(all.samples.len(), 9600);
        assert!(all.gaps.is_empty());
        assert_eq!(c.snapshot("A", Some(0.05)).unwrap().samples.len(), 2400);
        assert!(c.snapshot("B", None).is_none());
    }

    #[test]
    fn input_jumps_and_restarts_are_marked_where_they_happen() {
        let mut c = Captures::default();
        feed(&mut c, "A", 4800, (1, 1), 0);
        feed(&mut c, "A", 4800, (1, 1), 50_000);
        feed(&mut c, "A", 4800, (2, 1), 0);
        let s = c.snapshot("A", None).unwrap();
        assert_eq!(s.gaps, vec![(4800, "input sample discontinuity"), (9600, "source or decoder restart")]);
        // A shorter tail renumbers from its own start and drops the earlier gap.
        assert_eq!(c.snapshot("A", Some(0.15)).unwrap().gaps, vec![(2400, "source or decoder restart")]);
    }

    #[test]
    fn holds_two_minutes_and_trims_old_gaps() {
        let mut c = Captures::default();
        feed(&mut c, "A", 4800, (1, 1), 0);
        feed(&mut c, "A", 4800, (2, 1), 0);
        let limit = RATE as usize * MAX_SECONDS;
        feed(&mut c, "A", limit, (2, 1), 9600);
        let s = c.snapshot("A", None).unwrap();
        assert_eq!(s.samples.len(), limit);
        assert!(s.gaps.is_empty());
    }

    #[test]
    fn evicts_the_least_recently_heard_channel() {
        let mut c = Captures::default();
        for id in ["A", "B", "C", "D"] {
            feed(&mut c, id, 10, (1, 1), 0);
        }
        feed(&mut c, "A", 10, (1, 1), 20);
        feed(&mut c, "E", 10, (1, 1), 0);
        assert!(c.snapshot("B", None).is_none());
        assert!(c.snapshot("A", None).is_some());
        assert!(c.snapshot("E", None).is_some());
    }
}
