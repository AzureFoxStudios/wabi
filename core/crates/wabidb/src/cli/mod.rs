//! Operator-facing CLI commands (wabidb check, dump-stream, decrypt, etc.).

pub mod backup;
pub mod check;
pub mod decrypt;
pub mod dump_stream;
pub mod list_streams;
pub mod rebuild_indexes;
pub mod rebuild_indexes_cmd;
pub mod restore;
pub mod status;
pub mod tail;
pub mod verify;
