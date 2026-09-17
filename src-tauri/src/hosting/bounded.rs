//! Bounds are enforced while reading, not after an unbounded allocation.
use std::io::{self, BufRead};

pub fn append(bytes: &mut Vec<u8>, chunk: &[u8], limit: usize) -> io::Result<()> {
    if chunk.len() > limit.saturating_sub(bytes.len()) || bytes.len() > limit {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Authority response exceeds the supported size"));
    }
    bytes.extend_from_slice(chunk); Ok(())
}

/// Discard an oversized/invalid UTF-8 line through its newline, then continue.
/// The caller's BufRead implementation supplies a bounded internal read buffer.
pub fn for_each_line<R: BufRead>(mut reader: R, limit: usize, mut visit: impl FnMut(&str)) -> io::Result<()> {
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if !oversized && !line.is_empty() { if let Ok(text) = std::str::from_utf8(&line) { visit(text.trim_end_matches('\r')); } }
            return Ok(());
        }
        let newline = available.iter().position(|&byte| byte == b'\n');
        let length = newline.unwrap_or(available.len());
        if !oversized && append(&mut line, &available[..length], limit).is_err() {
            oversized = true; line.clear();
        }
        reader.consume(length + usize::from(newline.is_some()));
        if newline.is_some() {
            if !oversized { if let Ok(text) = std::str::from_utf8(&line) { visit(text.trim_end_matches('\r')); } }
            line.clear(); oversized = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn accepts_limit_and_rejects_next_chunk_without_mutation() {
        let mut bytes = Vec::new(); append(&mut bytes, b"1234", 4).unwrap();
        assert!(append(&mut bytes, b"5", 4).is_err()); assert_eq!(bytes, b"1234");
    }
    #[test] fn long_line_does_not_hide_next_announcement() {
        let data = format!("{}\nready\r\nlast", "x".repeat(1_000_000));
        let reader = io::BufReader::with_capacity(16, data.as_bytes());
        let mut found = Vec::new(); for_each_line(reader, 8, |s| found.push(s.to_string())).unwrap();
        assert_eq!(found, ["ready", "last"]);
    }
    #[test] fn invalid_utf8_is_skipped_and_final_line_is_delivered() {
        let mut found = Vec::new(); for_each_line(io::Cursor::new(b"\xff\nok"), 8, |s| found.push(s.to_string())).unwrap();
        assert_eq!(found, ["ok"]);
    }
    #[test] fn exact_size_line_is_allowed() {
        let mut found = Vec::new(); for_each_line(io::Cursor::new(b"1234\n12345\n"), 4, |s| found.push(s.to_string())).unwrap();
        assert_eq!(found, ["1234"]);
    }
}
