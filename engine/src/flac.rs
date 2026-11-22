//! Lossless audio files for the browser: mono 16-bit FLAC, written by HamFLAC.
use std::ffi::c_int;

unsafe extern "C" {
    fn earshot_flac_encode(samples: *const i16, count: usize, sample_rate: c_int, out: *mut *mut u8, out_len: *mut usize) -> c_int;
    fn earshot_flac_free(bytes: *mut u8);
}

/// Encode mono samples. `None` when there is nothing to encode or the encoder refused.
pub fn encode(samples: &[i16], sample_rate: u32) -> Option<Vec<u8>> {
    if samples.is_empty() {
        return None;
    }
    let mut out = std::ptr::null_mut();
    let mut len = 0;
    // SAFETY: `samples` is valid for `len()` reads; on success the callee hands back a malloc'd
    // buffer of `len` bytes, copied here and released with its own free.
    unsafe {
        if earshot_flac_encode(samples.as_ptr(), samples.len(), sample_rate as c_int, &mut out, &mut len) != 0 {
            return None;
        }
        let bytes = std::slice::from_raw_parts(out, len).to_vec();
        earshot_flac_free(out);
        Some(bytes)
    }
}

/// Add a VORBIS_COMMENT block right after STREAMINFO. Seek table offsets count from the first
/// audio frame, so they stay correct.
pub fn with_comments(mut flac: Vec<u8>, comments: &[(&str, String)]) -> Option<Vec<u8>> {
    if flac.get(..4)? != b"fLaC" {
        return None;
    }
    let header = *flac.get(4)?;
    if header & 0x7f != 0 {
        return None; // STREAMINFO must come first
    }
    let length = u32::from_be_bytes([0, *flac.get(5)?, *flac.get(6)?, *flac.get(7)?]) as usize;
    let insert_at = 8 + length;
    if flac.len() < insert_at {
        return None;
    }
    const VENDOR: &[u8] = b"earshot";
    let mut body = Vec::new();
    body.extend_from_slice(&(VENDOR.len() as u32).to_le_bytes());
    body.extend_from_slice(VENDOR);
    body.extend_from_slice(&(comments.len() as u32).to_le_bytes());
    for (key, value) in comments {
        let entry = format!("{key}={value}");
        body.extend_from_slice(&(entry.len() as u32).to_le_bytes());
        body.extend_from_slice(entry.as_bytes());
    }
    if body.len() >= 1 << 24 {
        return None;
    }
    // The new block inherits STREAMINFO's "last metadata block" flag.
    let mut block = vec![(header & 0x80) | 4];
    block.extend_from_slice(&(body.len() as u32).to_be_bytes()[1..]);
    block.extend_from_slice(&body);
    flac[4] = header & 0x7f;
    flac.splice(insert_at..insert_at, block);
    Some(flac)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(n: usize) -> Vec<i16> {
        (0..n).map(|i| ((i as f64 * 0.11).sin() * 9000.) as i16).collect()
    }

    #[test]
    fn writes_a_flac_stream_smaller_than_pcm() {
        let pcm = tone(8000);
        let flac = encode(&pcm, 8000).unwrap();
        assert_eq!(&flac[..4], b"fLaC");
        assert!(flac.len() < pcm.len() * 2);
        assert!(encode(&[], 8000).is_none());
    }

    #[test]
    fn comment_block_follows_streaminfo_and_keeps_the_chain_valid() {
        let flac = encode(&tone(4000), 48000).unwrap();
        let out = with_comments(flac.clone(), &[("TITLE", "raw FM".into())]).unwrap();
        assert_eq!(out[4] & 0x7f, 0);
        assert_eq!(out[4 + 4 + 34] & 0x7f, 4);
        // Walk the metadata chain: exactly one block carries the last flag, then a frame sync.
        let (mut at, mut blocks) = (4, 0);
        loop {
            let head = out[at];
            let len = u32::from_be_bytes([0, out[at + 1], out[at + 2], out[at + 3]]) as usize;
            at += 4 + len;
            blocks += 1;
            if head & 0x80 != 0 {
                break;
            }
        }
        assert!(blocks >= 2);
        assert_eq!(out[at], 0xff);
        assert_eq!(out[at + 1] & 0xfc, 0xf8);
    }
}
