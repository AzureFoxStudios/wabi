//! Durable desktop profile and an OS-released, cross-process operation lock.
//! The lock is never removed or recovered using a saved process identifier.
use std::{fs, path::Path};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::archive;

type Result<T> = std::result::Result<T, String>;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub version: u32,
    pub port: u16,
    pub server_id: String,
    pub data_directory: String,
}

pub struct ProfileLease {
    _file: fs::File,
}

impl ProfileLease {
    pub fn acquire(root: &Path) -> Result<Self> {
        archive::private_dir(root)?;
        let path = root.join("host-operation.lock");
        if fs::symlink_metadata(&path).is_ok_and(|metadata| !metadata.is_file()) {
            return Err(
                "The hosting operation lock is not a regular file. Check the hosting folder."
                    .into(),
            );
        }
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(path)
            .map_err(|e| format!("Cannot open the hosting operation lock: {e}"))?;
        file.try_lock().map_err(|_| "Another Wabi app is managing this community, or its folder does not support safe locking. Quit the other app before hosting here.".to_string())?;
        Ok(Self { _file: file })
    }
}

impl Drop for ProfileLease {
    fn drop(&mut self) {
        // A concurrent process spawn can briefly inherit this descriptor before
        // close-on-exec runs. Explicitly unlock our lease rather than making
        // profile reopening wait for that unrelated child to finish exec.
        let _ = self._file.unlock();
    }
}

pub fn identity(data: &Path) -> Result<String> {
    let path = data.join("wabidb/root_key");
    let metadata = fs::symlink_metadata(&path).map_err(|e| format!("The community identity key is missing or unreadable. Restore a complete backup; no new identity was created. {e}"))?;
    if !metadata.is_file() || metadata.len() > 1024 || metadata.len() == 0 {
        return Err("The community identity key is invalid. Restore a complete backup; no new identity was created.".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub fn load(root: &Path) -> Result<Option<Settings>> {
    let path = root.join("host.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Cannot read hosting settings: {e}")),
    };
    if !metadata.is_file() || metadata.len() > 16 * 1024 {
        return Err(
            "Hosting settings are not a valid regular file; your data has been kept.".into(),
        );
    }
    let settings: Settings = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "Hosting settings are damaged. Keep the hosting folder and restore the matching host.json from a full hosting-folder backup; settings were not reset.".to_string())?;
    if settings.version != 1
        || settings.port == 0
        || settings.server_id.len() != 64
        || !settings
            .server_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Unsupported or incomplete hosting settings. Your data has been kept.".into());
    }
    Ok(Some(settings))
}

pub fn validate_identity(root: &Path, settings: &Settings) -> Result<()> {
    let directory = fs::canonicalize(root.join("data"))
        .map_err(|e| format!("The saved community folder is unavailable: {e}"))?;
    if directory.to_string_lossy() != settings.data_directory {
        return Err("The saved community folder has moved. Restore the matching hosting folder to its original location before starting; no data was changed.".into());
    }
    if identity(&root.join("data"))? != settings.server_id {
        return Err("This data folder belongs to a different community. Restore its matching hosting profile; Wabi did not replace either identity.".into());
    }
    Ok(())
}

pub fn save_new(root: &Path, port: u16) -> Result<()> {
    let directory = fs::canonicalize(root.join("data")).map_err(|e| e.to_string())?;
    let settings = Settings {
        version: 1,
        port,
        server_id: identity(&root.join("data"))?,
        data_directory: directory.to_string_lossy().into_owned(),
    };
    archive::write_private(
        &root.join("host.json"),
        &serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?,
    )
}

pub fn bootstrap_token() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|e| format!("Cannot obtain secure randomness for owner setup: {e}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("wabi-host-profile-{}", bootstrap_token().unwrap()));
            archive::private_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn one_app_owns_profile_until_its_lease_is_dropped() {
        let temp = Temp::new();
        let first = ProfileLease::acquire(&temp.0).unwrap();
        assert!(ProfileLease::acquire(&temp.0).is_err());
        drop(first);
        assert!(ProfileLease::acquire(&temp.0).is_ok());
    }

    #[test]
    fn reopened_profile_preserves_port_and_rejects_missing_or_replaced_identity() {
        let temp = Temp::new();
        archive::private_dir(&temp.0.join("data/wabidb")).unwrap();
        let key = temp.0.join("data/wabidb/root_key");
        archive::write_private(&key, b"first-key").unwrap();
        save_new(&temp.0, 31337).unwrap();
        let settings = load(&temp.0).unwrap().unwrap();
        assert_eq!(settings.port, 31337);
        validate_identity(&temp.0, &settings).unwrap();
        fs::write(&key, b"different-key").unwrap();
        assert!(validate_identity(&temp.0, &settings).is_err());
        fs::remove_file(key).unwrap();
        assert!(validate_identity(&temp.0, &settings).is_err());
        assert!(temp.0.join("host.json").is_file());
    }

    #[test]
    fn damaged_profile_is_not_replaced() {
        let temp = Temp::new();
        let path = temp.0.join("host.json");
        archive::write_private(&path, b"{broken").unwrap();
        assert!(load(&temp.0).is_err());
        assert_eq!(fs::read(path).unwrap(), b"{broken");
    }

    #[test]
    fn bootstrap_tokens_are_independent_and_not_persisted() {
        let first = bootstrap_token().unwrap();
        assert_eq!(first.len(), 64);
        assert_ne!(first, bootstrap_token().unwrap());
    }
}
