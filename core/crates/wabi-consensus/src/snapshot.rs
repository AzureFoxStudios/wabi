//! Bound snapshot allocation while receiving, before installation validation.
use std::{
    io::{self, Cursor, SeekFrom},
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf};

pub struct BoundedSnapshot {
    cursor: Cursor<Vec<u8>>,
    maximum: u64,
}
impl BoundedSnapshot {
    pub fn new(maximum: u64) -> Self {
        Self {
            cursor: Cursor::new(Vec::new()),
            maximum,
        }
    }
    pub fn from_bytes(bytes: Vec<u8>, maximum: u64) -> io::Result<Self> {
        if bytes.len() as u64 > maximum {
            return Err(io::Error::other("snapshot budget exceeded"));
        }
        Ok(Self {
            cursor: Cursor::new(bytes),
            maximum,
        })
    }
    pub(crate) fn into_bytes(self) -> Vec<u8> {
        self.cursor.into_inner()
    }
}
impl AsyncRead for BoundedSnapshot {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.cursor).poll_read(cx, out)
    }
}
impl AsyncWrite for BoundedSnapshot {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self
            .cursor
            .position()
            .checked_add(bytes.len() as u64)
            .is_none_or(|end| end > self.maximum)
        {
            return Poll::Ready(Err(io::Error::other("snapshot budget exceeded")));
        }
        Pin::new(&mut self.cursor).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.cursor).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.cursor).poll_shutdown(cx)
    }
}
impl AsyncSeek for BoundedSnapshot {
    fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> io::Result<()> {
        let target = match position {
            SeekFrom::Start(value) => i128::from(value),
            SeekFrom::Current(delta) => i128::from(self.cursor.position()) + i128::from(delta),
            SeekFrom::End(delta) => self.cursor.get_ref().len() as i128 + i128::from(delta),
        };
        if target < 0 || target > i128::from(self.maximum) {
            return Err(io::Error::other("snapshot seek budget exceeded"));
        }
        Pin::new(&mut self.cursor).start_seek(position)
    }
    fn poll_complete(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Pin::new(&mut self.cursor).poll_complete(cx)
    }
}
