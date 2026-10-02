//! One handshake and one RPC per TCP connection. Application data starts only
//! after both KK messages have completed. No plaintext or early-data fallback.
use super::{Config, Error, Result, PATTERN};
use snow::{HandshakeState, TransportState};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const HELLO_SIZE: usize = 118;
const HANDSHAKE_MAX: usize = 512;
const CHUNK: usize = 32 * 1024;
const TAG: usize = 16;
const DOMAIN: &[u8] = b"wabi-recovery-rpc/noise-kk-v1\0";

pub(super) struct Channel<S> {
    pub(super) stream: S,
    noise: TransportState,
    maximum: usize,
}

impl Config {
    fn hello(&self, from: u64, to: u64) -> Result<[u8; HELLO_SIZE]> {
        if from == to || !self.peers.contains_key(&from) || !self.peers.contains_key(&to) {
            return Err(Error::Authentication);
        }
        let mut hello = [0; HELLO_SIZE];
        hello[..4].copy_from_slice(b"WRC1");
        hello[4..6].copy_from_slice(&crate::model::CONTROL_PROTOCOL.to_be_bytes());
        hello[6..14].copy_from_slice(&from.to_be_bytes());
        hello[14..22].copy_from_slice(&to.to_be_bytes());
        hello[22..54].copy_from_slice(&self.community);
        hello[54..86].copy_from_slice(&self.partition);
        hello[86..118].copy_from_slice(&self.roster_digest);
        Ok(hello)
    }
    fn handshake(&self, remote: u64, hello: &[u8], initiator: bool) -> Result<HandshakeState> {
        let peer = self.keys.get(&remote).ok_or(Error::Authentication)?;
        let mut prologue = Vec::with_capacity(DOMAIN.len() + hello.len());
        prologue.extend_from_slice(DOMAIN);
        prologue.extend_from_slice(hello);
        let builder = snow::Builder::new(PATTERN.parse().map_err(|_| Error::Authentication)?)
            .local_private_key(self.identity.private_bytes())
            .map_err(|_| Error::Authentication)?
            .remote_public_key(peer)
            .map_err(|_| Error::Authentication)?
            .prologue(&prologue)
            .map_err(|_| Error::Authentication)?;
        if initiator {
            builder.build_initiator()
        } else {
            builder.build_responder()
        }
        .map_err(|_| Error::Authentication)
    }
    pub(super) async fn connect<S>(&self, mut stream: S, target: u64) -> Result<Channel<S>>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        let hello = self.hello(self.binding.node_id, target)?;
        stream.write_all(&hello).await.map_err(|_| Error::Io)?;
        let mut noise = self.handshake(target, &hello, true)?;
        let mut message = [0; HANDSHAKE_MAX];
        let n = noise
            .write_message(&[], &mut message)
            .map_err(|_| Error::Authentication)?;
        frame_write(&mut stream, &message[..n]).await?;
        let reply = frame_read(&mut stream, HANDSHAKE_MAX).await?;
        let n = noise
            .read_message(&reply, &mut message)
            .map_err(|_| Error::Authentication)?;
        if n != 0 || !noise.is_handshake_finished() {
            return Err(Error::Authentication);
        }
        Ok(Channel {
            stream,
            noise: noise
                .into_transport_mode()
                .map_err(|_| Error::Authentication)?,
            maximum: self.limits.max_rpc_bytes,
        })
    }
    pub(super) async fn accept<S>(&self, mut stream: S) -> Result<(u64, Channel<S>)>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        let mut hello = [0; HELLO_SIZE];
        stream.read_exact(&mut hello).await.map_err(|_| Error::Io)?;
        let from = u64::from_be_bytes(hello[6..14].try_into().map_err(|_| Error::Protocol)?);
        let expected = self.hello(from, self.binding.node_id)?;
        if hello != expected {
            return Err(Error::Authentication);
        }
        let mut noise = self.handshake(from, &hello, false)?;
        let first = frame_read(&mut stream, HANDSHAKE_MAX).await?;
        let mut message = [0; HANDSHAKE_MAX];
        let n = noise
            .read_message(&first, &mut message)
            .map_err(|_| Error::Authentication)?;
        if n != 0 {
            return Err(Error::Authentication);
        }
        let n = noise
            .write_message(&[], &mut message)
            .map_err(|_| Error::Authentication)?;
        if !noise.is_handshake_finished() {
            return Err(Error::Authentication);
        }
        frame_write(&mut stream, &message[..n]).await?;
        Ok((
            from,
            Channel {
                stream,
                noise: noise
                    .into_transport_mode()
                    .map_err(|_| Error::Authentication)?,
                maximum: self.limits.max_rpc_bytes,
            },
        ))
    }
}

async fn frame_write<S: AsyncWrite + Unpin>(stream: &mut S, bytes: &[u8]) -> Result<()> {
    let len = u16::try_from(bytes.len()).map_err(|_| Error::Budget)?;
    if len == 0 {
        return Err(Error::Protocol);
    }
    stream.write_u16(len).await.map_err(|_| Error::Io)?;
    stream.write_all(bytes).await.map_err(|_| Error::Io)?;
    stream.flush().await.map_err(|_| Error::Io)
}
async fn frame_read<S: AsyncRead + Unpin>(stream: &mut S, maximum: usize) -> Result<Vec<u8>> {
    let length = stream.read_u16().await.map_err(|_| Error::Io)? as usize;
    if length == 0 || length > maximum {
        return Err(Error::Budget);
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await.map_err(|_| Error::Io)?;
    Ok(bytes)
}
impl<S: AsyncRead + AsyncWrite + Unpin> Channel<S> {
    async fn encrypt(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.len() > CHUNK {
            return Err(Error::Budget);
        }
        let mut output = vec![0; bytes.len() + TAG];
        let n = self
            .noise
            .write_message(bytes, &mut output)
            .map_err(|_| Error::Authentication)?;
        frame_write(&mut self.stream, &output[..n]).await
    }
    async fn decrypt(&mut self, expected: usize) -> Result<Vec<u8>> {
        let cipher = frame_read(&mut self.stream, expected + TAG).await?;
        if cipher.len() != expected + TAG {
            return Err(Error::Protocol);
        }
        let mut bytes = vec![0; expected];
        let n = self
            .noise
            .read_message(&cipher, &mut bytes)
            .map_err(|_| Error::Authentication)?;
        if n != expected {
            return Err(Error::Protocol);
        }
        Ok(bytes)
    }
    pub(super) async fn send(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() || bytes.len() > self.maximum {
            return Err(Error::Budget);
        }
        self.encrypt(&(bytes.len() as u32).to_be_bytes()).await?;
        for chunk in bytes.chunks(CHUNK) {
            self.encrypt(chunk).await?;
        }
        Ok(())
    }
    pub(super) async fn receive(&mut self) -> Result<Vec<u8>> {
        let size = u32::from_be_bytes(
            self.decrypt(4)
                .await?
                .try_into()
                .map_err(|_| Error::Protocol)?,
        ) as usize;
        if size == 0 || size > self.maximum {
            return Err(Error::Budget);
        }
        let mut bytes = Vec::with_capacity(size);
        while bytes.len() < size {
            let expected = (size - bytes.len()).min(CHUNK);
            bytes.extend_from_slice(&self.decrypt(expected).await?);
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests;
