//! Node secrets are supplied explicitly; never derived from a helper token,
//! Wabi account, community root key or another node's credential.
use super::{Error, Result, PATTERN};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
};
use zeroize::{Zeroize, Zeroizing};

pub struct Identity {
    secret: Zeroizing<[u8; 32]>,
    public: [u8; 32],
}
impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RecoveryIdentity([REDACTED])")
    }
}
impl Identity {
    pub fn generate() -> Result<Self> {
        let builder = snow::Builder::new(PATTERN.parse().map_err(|_| Error::Authentication)?);
        let mut key = builder
            .generate_keypair()
            .map_err(|_| Error::Authentication)?;
        let bytes_result = key
            .private
            .as_slice()
            .try_into()
            .map_err(|_| Error::Authentication);
        key.private.zeroize();
        Ok(Self::from_private(bytes_result?))
    }
    pub fn from_private(bytes: [u8; 32]) -> Self {
        let secret = Zeroizing::new(bytes);
        let static_key = x25519_dalek::StaticSecret::from(*secret);
        let public = x25519_dalek::PublicKey::from(&static_key).to_bytes();
        Self { secret, public }
    }
    pub fn public_hex(&self) -> String {
        hex::encode(self.public)
    }
    /// Explicit bootstrap publication in an already-private directory. Existing
    /// keys are never overwritten, and a partial file is never regenerated.
    pub fn persist_new(&self, directory: &Path) -> Result<()> {
        private_directory(directory)?;
        let path = directory.join("recovery.key");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path).map_err(|_| Error::Authentication)?;
        file.write_all(self.private_bytes())
            .map_err(|_| Error::Io)?;
        file.sync_all().map_err(|_| Error::Io)?;
        fs::File::open(directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| Error::Io)
    }
    /// No fallback generation on absent, corrupt, public or substituted keys.
    pub fn load(directory: &Path) -> Result<Self> {
        private_directory(directory)?;
        let path = directory.join("recovery.key");
        let metadata = fs::symlink_metadata(&path).map_err(|_| Error::Authentication)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != 32 {
            return Err(Error::Authentication);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if metadata.nlink() != 1 || metadata.permissions().mode() & 0o077 != 0 {
                return Err(Error::Authentication);
            }
        }
        let mut file = fs::File::open(path).map_err(|_| Error::Authentication)?;
        let held = file.metadata().map_err(|_| Error::Authentication)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if (held.dev(), held.ino()) != (metadata.dev(), metadata.ino())
                || held.nlink() != 1
                || held.permissions().mode() & 0o077 != 0
            {
                return Err(Error::Authentication);
            }
        }
        if held.len() != 32 {
            return Err(Error::Authentication);
        }
        let mut bytes = Zeroizing::new([0; 32]);
        file.read_exact(bytes.as_mut())
            .map_err(|_| Error::Authentication)?;
        let mut tail = [0; 1];
        if file.read(&mut tail).map_err(|_| Error::Authentication)? != 0 {
            return Err(Error::Authentication);
        }
        Ok(Self::from_private(*bytes))
    }
    pub(super) fn private_bytes(&self) -> &[u8; 32] {
        &self.secret
    }
    pub(super) fn public_bytes(&self) -> &[u8; 32] {
        &self.public
    }
}

fn private_directory(directory: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(directory).map_err(|_| Error::Authentication)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::Authentication);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(Error::Authentication);
        }
    }
    Ok(())
}
