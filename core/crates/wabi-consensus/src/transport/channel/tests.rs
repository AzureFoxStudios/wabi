use super::*;
use crate::transport::tests::fixture;
use std::{
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};

struct Capture<S> {
    stream: S,
    written: Arc<Mutex<Vec<u8>>>,
}
impl<S: AsyncRead + Unpin> AsyncRead for Capture<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buffer)
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for Capture<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let result = Pin::new(&mut self.stream).poll_write(cx, bytes);
        if let Poll::Ready(Ok(n)) = result {
            let mut record = self.written.lock().unwrap();
            if record.len() + n > 2 * 1024 * 1024 {
                return Poll::Ready(Err(std::io::Error::other("test capture budget")));
            }
            record.extend_from_slice(&bytes[..n]);
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

#[tokio::test]
async fn mutually_authenticated_fragmented_data_stays_encrypted_and_replayed_frame_refuses() {
    let configs = fixture();
    let (a, b) = tokio::io::duplex(64 * 1024);
    let written = Arc::new(Mutex::new(Vec::new()));
    let record = written.clone();
    let sender = configs[0].clone();
    let payload = b"private-fixture-message-".repeat(4000);
    let sent = payload.clone();
    let task = tokio::spawn(async move {
        let mut channel = sender
            .connect(
                Capture {
                    stream: a,
                    written: record.clone(),
                },
                2,
            )
            .await
            .unwrap();
        channel.send(&sent).await.unwrap();
        let wire = record.lock().unwrap().clone();
        assert!(!wire
            .windows(b"private-fixture-message-".len())
            .any(|window| window == b"private-fixture-message-"));
        let handshake_len =
            u16::from_be_bytes(wire[HELLO_SIZE..HELLO_SIZE + 2].try_into().unwrap()) as usize;
        let frames = &wire[HELLO_SIZE + 2 + handshake_len..];
        // Replay the already consumed authenticated length frame; receiver's
        // monotonically advanced Noise counter must reject it.
        channel.stream.write_all(&frames[..22]).await.unwrap();
    });
    let (source, mut channel) = configs[1].accept(b).await.unwrap();
    assert_eq!(source, 1);
    assert_eq!(channel.receive().await.unwrap(), payload);
    assert_eq!(channel.receive().await.unwrap_err(), Error::Authentication);
    task.await.unwrap();
}

#[tokio::test]
async fn wrong_private_key_community_partition_roster_and_target_refuse_before_rpc() {
    for fault in ["private_key", "community", "partition", "roster", "target"] {
        let configs = fixture();
        let mut sender = configs[0].clone();
        match fault {
            "private_key" => {
                sender.identity = Arc::new(crate::transport::Identity::generate().unwrap())
            }
            "community" => sender.community[0] ^= 1,
            "partition" => sender.partition[0] ^= 1,
            "roster" => sender.roster_digest[0] ^= 1,
            _ => (),
        }
        let target = if fault == "target" { 3 } else { 2 };
        let (a, b) = tokio::io::duplex(2048);
        let connect = tokio::spawn(async move { sender.connect(a, target).await.is_err() });
        assert!(
            tokio::time::timeout(Duration::from_secs(1), configs[1].accept(b))
                .await
                .unwrap()
                .is_err(),
            "{fault}"
        );
        assert!(connect.await.unwrap(), "{fault}");
    }
}

#[tokio::test]
async fn authenticated_oversized_length_and_cipher_tampering_refuse() {
    for tamper in [false, true] {
        let configs = fixture();
        let (a, b) = tokio::io::duplex(2048);
        let sender = configs[0].clone();
        let task = tokio::spawn(async move {
            let mut channel = sender.connect(a, 2).await.unwrap();
            if tamper {
                let mut cipher = [0; 20];
                channel
                    .noise
                    .write_message(&16u32.to_be_bytes(), &mut cipher)
                    .unwrap();
                cipher[10] ^= 1;
                frame_write(&mut channel.stream, &cipher).await.unwrap();
            } else {
                channel
                    .encrypt(&((1024 * 1024 + 1) as u32).to_be_bytes())
                    .await
                    .unwrap();
            }
        });
        let (_, mut receiver) = configs[1].accept(b).await.unwrap();
        assert_eq!(
            receiver.receive().await.unwrap_err(),
            if tamper {
                Error::Authentication
            } else {
                Error::Budget
            }
        );
        task.await.unwrap();
    }
}

#[tokio::test]
async fn malformed_or_stalled_handshake_has_bounded_read_and_no_plaintext_fallback() {
    let configs = fixture();
    let (mut a, b) = tokio::io::duplex(2048);
    let hello = configs[0].hello(1, 2).unwrap();
    a.write_all(&hello).await.unwrap();
    a.write_u16(u16::MAX).await.unwrap();
    assert!(matches!(configs[1].accept(b).await, Err(Error::Budget)));
    let (_a, b) = tokio::io::duplex(2048);
    assert!(
        tokio::time::timeout(Duration::from_millis(30), configs[1].accept(b))
            .await
            .is_err()
    );
}
