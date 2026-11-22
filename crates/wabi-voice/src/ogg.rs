//! Minimal Ogg page writing and reading for the relay's Ogg Opus streams.
//!
//! The relay carries whole Ogg pages, one per envelope. This module writes
//! pages the browser clients' decoder accepts and reads the pages their
//! encoder (opus-recorder) produces. It is not a general Ogg implementation:
//! one logical stream, no seeking, no chaining.

const CAPTURE_PATTERN: &[u8; 4] = b"OggS";
const HEADER_LEN: usize = 27;
const FLAG_CONTINUED: u8 = 0x01;
const FLAG_BOS: u8 = 0x02;
const FLAG_EOS: u8 = 0x04;

/// Ogg's CRC-32: polynomial 0x04c11db7, no reflection, initial value 0.
fn crc32(data: &[u8]) -> u32 {
    const TABLE: [u32; 256] = {
        let mut table = [0u32; 256];
        let mut index = 0;
        while index < 256 {
            let mut value = (index as u32) << 24;
            let mut bit = 0;
            while bit < 8 {
                value = if value & 0x8000_0000 != 0 {
                    (value << 1) ^ 0x04c1_1db7
                } else {
                    value << 1
                };
                bit += 1;
            }
            table[index] = value;
            index += 1;
        }
        table
    };
    data.iter().fold(0u32, |crc, byte| {
        (crc << 8) ^ TABLE[(((crc >> 24) as u8) ^ byte) as usize]
    })
}

/// Writes pages that each hold whole packets.
pub struct PageWriter {
    serial: u32,
    sequence: u32,
}

impl PageWriter {
    pub fn new(serial: u32) -> Self {
        Self {
            serial,
            sequence: 0,
        }
    }

    /// One page holding `packets` in full. `granule` is the stream position
    /// after the last packet. Panics if the packets need more than 255 lacing
    /// values, which the callers' packet sizes never approach.
    pub fn page(&mut self, packets: &[&[u8]], granule: u64, bos: bool, eos: bool) -> Vec<u8> {
        let mut lacing = Vec::new();
        for packet in packets {
            let mut remaining = packet.len();
            while remaining >= 255 {
                lacing.push(255u8);
                remaining -= 255;
            }
            lacing.push(remaining as u8);
        }
        assert!(lacing.len() <= 255, "packets do not fit one Ogg page");
        let body_len: usize = packets.iter().map(|packet| packet.len()).sum();
        let mut page = Vec::with_capacity(HEADER_LEN + lacing.len() + body_len);
        page.extend_from_slice(CAPTURE_PATTERN);
        page.push(0); // stream structure version
        page.push(if bos { FLAG_BOS } else { 0 } | if eos { FLAG_EOS } else { 0 });
        page.extend_from_slice(&granule.to_le_bytes());
        page.extend_from_slice(&self.serial.to_le_bytes());
        page.extend_from_slice(&self.sequence.to_le_bytes());
        page.extend_from_slice(&[0; 4]); // checksum, filled below
        page.push(lacing.len() as u8);
        page.extend_from_slice(&lacing);
        for packet in packets {
            page.extend_from_slice(packet);
        }
        let checksum = crc32(&page);
        page[22..26].copy_from_slice(&checksum.to_le_bytes());
        self.sequence = self.sequence.wrapping_add(1);
        page
    }
}

/// A packet completed by [`PageReader::push`].
#[derive(Debug, PartialEq, Eq)]
pub struct Packet {
    pub data: Vec<u8>,
    /// The page that completed this packet began a stream.
    pub bos: bool,
}

/// Reads packets out of whole pages handed over in arrival order.
#[derive(Default)]
pub struct PageReader {
    partial: Vec<u8>,
}

impl PageReader {
    /// Parses every page in `bytes` and returns the packets they complete.
    /// Malformed input ends parsing; what was complete so far is returned and
    /// any half-built packet is dropped.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Packet> {
        let mut packets = Vec::new();
        let mut offset = 0;
        while bytes.len() >= offset + HEADER_LEN {
            let page = &bytes[offset..];
            if &page[0..4] != CAPTURE_PATTERN || page[4] != 0 {
                self.partial.clear();
                break;
            }
            let flags = page[5];
            let segments = page[26] as usize;
            if page.len() < HEADER_LEN + segments {
                self.partial.clear();
                break;
            }
            let lacing = &page[HEADER_LEN..HEADER_LEN + segments];
            let body_len: usize = lacing.iter().map(|value| *value as usize).sum();
            let body_start = HEADER_LEN + segments;
            if page.len() < body_start + body_len {
                self.partial.clear();
                break;
            }
            if flags & FLAG_BOS != 0 || flags & FLAG_CONTINUED == 0 {
                // A new stream, or a page that does not continue a packet:
                // whatever was half-built belongs to a page that never came.
                self.partial.clear();
            }
            let mut cursor = body_start;
            for value in lacing {
                let length = *value as usize;
                self.partial.extend_from_slice(&page[cursor..cursor + length]);
                cursor += length;
                if length < 255 {
                    packets.push(Packet {
                        data: std::mem::take(&mut self.partial),
                        bos: flags & FLAG_BOS != 0,
                    });
                }
            }
            offset += body_start + body_len;
        }
        packets
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `ogg` crate verifies page checksums and lacing independently of
    /// this module, so it is the reference for what a valid page is.
    #[test]
    fn an_independent_reader_accepts_the_pages() {
        let mut writer = PageWriter::new(0x1234_5678);
        let first = vec![5u8; 300];
        let second = vec![6u8; 17];
        let mut bytes = writer.page(&[b"OpusHead-like"], 0, true, false);
        bytes.extend(writer.page(&[&first, &second], 1920, false, false));
        bytes.extend(writer.page(&[b"last"], 2880, false, true));
        let mut reference = ::ogg::reading::PacketReader::new(std::io::Cursor::new(bytes));
        let mut read = Vec::new();
        while let Some(packet) = reference.read_packet().expect("valid Ogg") {
            read.push((packet.data.clone(), packet.absgp_page(), packet.stream_serial()));
        }
        assert_eq!(read.len(), 4);
        assert_eq!(read[0].0, b"OpusHead-like");
        assert_eq!(read[1].0, first);
        assert_eq!(read[2], (second, 1920, 0x1234_5678));
        assert_eq!(read[3].0, b"last");
    }

    /// And the other way: pages from the reference writer parse here.
    #[test]
    fn reads_pages_from_an_independent_writer() {
        let mut bytes = Vec::new();
        {
            let mut reference = ::ogg::writing::PacketWriter::new(&mut bytes);
            let end_page = ::ogg::writing::PacketWriteEndInfo::EndPage;
            reference.write_packet(vec![1u8; 19], 9, end_page, 0).unwrap();
            reference.write_packet(vec![2u8; 600], 9, ::ogg::writing::PacketWriteEndInfo::NormalPacket, 960).unwrap();
            reference.write_packet(vec![3u8; 40], 9, end_page, 1920).unwrap();
        }
        let packets = PageReader::default().push(&bytes);
        assert_eq!(packets.len(), 3);
        assert!(packets[0].bos);
        assert_eq!(packets[1].data, vec![2u8; 600]);
        assert_eq!(packets[2].data, vec![3u8; 40]);
    }

    #[test]
    fn pages_round_trip_including_long_packets() {
        let mut writer = PageWriter::new(7);
        let short = vec![1u8; 10];
        let exact = vec![2u8; 255];
        let long = vec![3u8; 700];
        let page = writer.page(&[&short, &exact, &long], 960, false, false);
        let mut reader = PageReader::default();
        let packets = reader.push(&page);
        assert_eq!(packets.len(), 3);
        assert_eq!(packets[0].data, short);
        assert_eq!(packets[1].data, exact);
        assert_eq!(packets[2].data, long);
        assert!(packets.iter().all(|packet| !packet.bos));
    }

    #[test]
    fn several_pages_in_one_buffer_and_the_bos_flag() {
        let mut writer = PageWriter::new(7);
        let mut bytes = writer.page(&[b"head"], 0, true, false);
        bytes.extend(writer.page(&[b"tags"], 0, false, false));
        let packets = PageReader::default().push(&bytes);
        assert_eq!(packets.len(), 2);
        assert!(packets[0].bos);
        assert!(!packets[1].bos);
        assert_eq!(u32::from_le_bytes(bytes[18..22].try_into().unwrap()), 0);
    }

    #[test]
    fn malformed_input_yields_nothing_and_does_not_panic() {
        let mut reader = PageReader::default();
        assert!(reader.push(b"not an ogg page at all, just text..").is_empty());
        let mut writer = PageWriter::new(1);
        let page = writer.page(&[&[9u8; 40]], 0, false, false);
        assert!(reader.push(&page[..page.len() - 5]).is_empty());
        assert_eq!(reader.push(&page).len(), 1);
    }
}
