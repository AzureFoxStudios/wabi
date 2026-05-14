use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub enum MessageRetentionDuration {
    #[serde(rename = "5s")]
    FiveSeconds,
    #[serde(rename = "30s")]
    ThirtySeconds,
    #[serde(rename = "1m")]
    OneMinute,
    #[serde(rename = "5m")]
    FiveMinutes,
    #[serde(rename = "30m")]
    ThirtyMinutes,
    #[serde(rename = "1h")]
    OneHour,
    #[serde(rename = "6h")]
    SixHours,
    #[serde(rename = "12h")]
    TwelveHours,
    #[serde(rename = "24h")]
    TwentyFourHours,
    #[serde(rename = "3d")]
    ThreeDays,
    #[serde(rename = "7d")]
    SevenDays,
    #[serde(rename = "14d")]
    FourteenDays,
    #[serde(rename = "30d")]
    ThirtyDays,
    #[serde(rename = "90d")]
    NinetyDays,
}

pub const MESSAGE_RETENTION_PRESETS: [MessageRetentionDuration; 14] = [
    MessageRetentionDuration::FiveSeconds,
    MessageRetentionDuration::ThirtySeconds,
    MessageRetentionDuration::OneMinute,
    MessageRetentionDuration::FiveMinutes,
    MessageRetentionDuration::ThirtyMinutes,
    MessageRetentionDuration::OneHour,
    MessageRetentionDuration::SixHours,
    MessageRetentionDuration::TwelveHours,
    MessageRetentionDuration::TwentyFourHours,
    MessageRetentionDuration::ThreeDays,
    MessageRetentionDuration::SevenDays,
    MessageRetentionDuration::FourteenDays,
    MessageRetentionDuration::ThirtyDays,
    MessageRetentionDuration::NinetyDays,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MessageRetentionParseError;

impl MessageRetentionDuration {
    pub const DEFAULT_DM: Self = Self::TwentyFourHours;

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FiveSeconds => "5s",
            Self::ThirtySeconds => "30s",
            Self::OneMinute => "1m",
            Self::FiveMinutes => "5m",
            Self::ThirtyMinutes => "30m",
            Self::OneHour => "1h",
            Self::SixHours => "6h",
            Self::TwelveHours => "12h",
            Self::TwentyFourHours => "24h",
            Self::ThreeDays => "3d",
            Self::SevenDays => "7d",
            Self::FourteenDays => "14d",
            Self::ThirtyDays => "30d",
            Self::NinetyDays => "90d",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::FiveSeconds => "5 seconds",
            Self::ThirtySeconds => "30 seconds",
            Self::OneMinute => "1 minute",
            Self::FiveMinutes => "5 minutes",
            Self::ThirtyMinutes => "30 minutes",
            Self::OneHour => "1 hour",
            Self::SixHours => "6 hours",
            Self::TwelveHours => "12 hours",
            Self::TwentyFourHours => "24 hours",
            Self::ThreeDays => "3 days",
            Self::SevenDays => "7 days",
            Self::FourteenDays => "14 days",
            Self::ThirtyDays => "30 days",
            Self::NinetyDays => "90 days",
        }
    }

    pub const fn to_ms(self) -> u64 {
        match self {
            Self::FiveSeconds => 5 * 1000,
            Self::ThirtySeconds => 30 * 1000,
            Self::OneMinute => 60 * 1000,
            Self::FiveMinutes => 5 * 60 * 1000,
            Self::ThirtyMinutes => 30 * 60 * 1000,
            Self::OneHour => 60 * 60 * 1000,
            Self::SixHours => 6 * 60 * 60 * 1000,
            Self::TwelveHours => 12 * 60 * 60 * 1000,
            Self::TwentyFourHours => 24 * 60 * 60 * 1000,
            Self::ThreeDays => 3 * 24 * 60 * 60 * 1000,
            Self::SevenDays => 7 * 24 * 60 * 60 * 1000,
            Self::FourteenDays => 14 * 24 * 60 * 60 * 1000,
            Self::ThirtyDays => 30 * 24 * 60 * 60 * 1000,
            Self::NinetyDays => 90 * 24 * 60 * 60 * 1000,
        }
    }
}

impl fmt::Display for MessageRetentionDuration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for MessageRetentionDuration {
    type Err = MessageRetentionParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        normalize_message_retention_duration(value).ok_or(MessageRetentionParseError)
    }
}

pub fn normalize_message_retention_duration(value: &str) -> Option<MessageRetentionDuration> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "5s" => Some(MessageRetentionDuration::FiveSeconds),
        "30s" => Some(MessageRetentionDuration::ThirtySeconds),
        "1m" => Some(MessageRetentionDuration::OneMinute),
        "5m" => Some(MessageRetentionDuration::FiveMinutes),
        "30m" => Some(MessageRetentionDuration::ThirtyMinutes),
        "1h" => Some(MessageRetentionDuration::OneHour),
        "6h" => Some(MessageRetentionDuration::SixHours),
        "12h" => Some(MessageRetentionDuration::TwelveHours),
        "24h" => Some(MessageRetentionDuration::TwentyFourHours),
        "3d" => Some(MessageRetentionDuration::ThreeDays),
        "7d" => Some(MessageRetentionDuration::SevenDays),
        "14d" => Some(MessageRetentionDuration::FourteenDays),
        "30d" => Some(MessageRetentionDuration::ThirtyDays),
        "90d" => Some(MessageRetentionDuration::NinetyDays),
        _ => None,
    }
}

pub fn message_retention_to_ms(duration: Option<MessageRetentionDuration>) -> Option<u64> {
    duration.map(MessageRetentionDuration::to_ms)
}

pub fn format_message_retention_label(duration: Option<MessageRetentionDuration>) -> &'static str {
    match duration {
        Some(duration) => duration.label(),
        None => "Never",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_match_typescript_order_and_values() {
        let values: Vec<&str> = MESSAGE_RETENTION_PRESETS
            .iter()
            .map(|duration| duration.as_str())
            .collect();

        assert_eq!(
            values,
            vec![
                "5s", "30s", "1m", "5m", "30m", "1h", "6h", "12h", "24h", "3d", "7d", "14d", "30d",
                "90d"
            ]
        );
    }

    #[test]
    fn preset_helpers_force_updates_when_duration_variants_change() {
        fn assert_known_duration(duration: MessageRetentionDuration) {
            let known = match duration {
                MessageRetentionDuration::FiveSeconds
                | MessageRetentionDuration::ThirtySeconds
                | MessageRetentionDuration::OneMinute
                | MessageRetentionDuration::FiveMinutes
                | MessageRetentionDuration::ThirtyMinutes
                | MessageRetentionDuration::OneHour
                | MessageRetentionDuration::SixHours
                | MessageRetentionDuration::TwelveHours
                | MessageRetentionDuration::TwentyFourHours
                | MessageRetentionDuration::ThreeDays
                | MessageRetentionDuration::SevenDays
                | MessageRetentionDuration::FourteenDays
                | MessageRetentionDuration::ThirtyDays
                | MessageRetentionDuration::NinetyDays => true,
            };

            assert!(known);
            assert!(MESSAGE_RETENTION_PRESETS.contains(&duration));
        }

        for duration in MESSAGE_RETENTION_PRESETS {
            assert_known_duration(duration);
        }
    }

    #[test]
    fn normalizes_trimmed_case_insensitive_values() {
        assert_eq!(
            normalize_message_retention_duration(" 24H "),
            Some(MessageRetentionDuration::TwentyFourHours)
        );
        assert_eq!(
            normalize_message_retention_duration("7d"),
            Some(MessageRetentionDuration::SevenDays)
        );
        assert_eq!(normalize_message_retention_duration("never"), None);
        assert_eq!(normalize_message_retention_duration(""), None);
    }

    #[test]
    fn converts_to_milliseconds_with_typescript_parity() {
        assert_eq!(
            message_retention_to_ms(Some(MessageRetentionDuration::FiveSeconds)),
            Some(5_000)
        );
        assert_eq!(
            message_retention_to_ms(Some(MessageRetentionDuration::TwentyFourHours)),
            Some(86_400_000)
        );
        assert_eq!(
            message_retention_to_ms(Some(MessageRetentionDuration::NinetyDays)),
            Some(7_776_000_000)
        );
        assert_eq!(message_retention_to_ms(None), None);
    }

    #[test]
    fn formats_labels_with_never_fallback() {
        assert_eq!(
            format_message_retention_label(Some(MessageRetentionDuration::OneMinute)),
            "1 minute"
        );
        assert_eq!(format_message_retention_label(None), "Never");
    }

    #[test]
    fn default_dm_retention_matches_current_typescript_default() {
        assert_eq!(MessageRetentionDuration::DEFAULT_DM.as_str(), "24h");
    }

    #[test]
    fn serde_strings_match_current_typescript_contract() {
        assert_eq!(
            serde_json::to_string(&MessageRetentionDuration::FiveSeconds).unwrap(),
            "\"5s\""
        );
        assert_eq!(
            serde_json::to_string(&MessageRetentionDuration::TwentyFourHours).unwrap(),
            "\"24h\""
        );
        assert_eq!(
            serde_json::from_str::<MessageRetentionDuration>("\"90d\"").unwrap(),
            MessageRetentionDuration::NinetyDays
        );
        assert!(serde_json::from_str::<MessageRetentionDuration>("\"never\"").is_err());
    }
}
