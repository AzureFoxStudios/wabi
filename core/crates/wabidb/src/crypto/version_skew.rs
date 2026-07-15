use crate::format::record::{RecordHeader, FORMAT_VERSION};

pub struct VersionInfo {
    pub record_version: u16,
    pub engine_version: u16,
    pub needs_re_encode: bool,
}

pub fn detect_version_skew(record_header: &RecordHeader) -> Option<VersionInfo> {
    let record_version = record_header.format_version;
    let engine_version = FORMAT_VERSION;

    if record_version == engine_version {
        return None;
    }

    Some(VersionInfo {
        record_version,
        engine_version,
        needs_re_encode: record_version != engine_version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::record::RecordKind;

    #[test]
    fn matching_version_returns_none() {
        let header = RecordHeader::new(RecordKind::Event, 1, [0u8; 16], 0, 0);
        assert!(detect_version_skew(&header).is_none());
    }

    #[test]
    fn old_version_detected() {
        let mut header = RecordHeader::new(RecordKind::Event, 1, [0u8; 16], 0, 0);
        header.format_version = 0;
        let info = detect_version_skew(&header).unwrap();
        assert_eq!(info.record_version, 0);
        assert_eq!(info.engine_version, FORMAT_VERSION);
        assert!(info.needs_re_encode);
    }

    #[test]
    fn new_version_detected() {
        let mut header = RecordHeader::new(RecordKind::Event, 1, [0u8; 16], 0, 0);
        header.format_version = 999;
        let info = detect_version_skew(&header).unwrap();
        assert_eq!(info.record_version, 999);
        assert_eq!(info.engine_version, FORMAT_VERSION);
        assert!(info.needs_re_encode);
    }
}
