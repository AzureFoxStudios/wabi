use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};
use wabi_consensus::transport::Identity;

fn private_root() -> tempfile::TempDir {
    tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap()
}

fn config(root: &Path) -> RecoveryNodeConfig {
    let community = "ab".repeat(32);
    let peers = (1..=3)
        .map(|id| {
            (
                id,
                RecoveryPeer {
                    protocol: 1,
                    community_id: community.clone(),
                    site_id: format!("site-{id}"),
                    public_key: Identity::generate().unwrap().public_hex(),
                    rpc_address: format!("127.0.0.1:{}", 15000 + id),
                },
            )
        })
        .collect();
    RecoveryNodeConfig {
        schema_version: 1,
        binding: StoreBinding {
            community_id: community,
            partition_id: "community/control".into(),
            node_id: 2,
        },
        peers,
        source_node_id: "fixture-authority".into(),
        identity_directory: root.join("identity"),
        control_directory: root.join("control"),
        material_directory: root.join("material"),
        bind_address: None,
        initialize: false,
        work_timeout_seconds: 10,
        rpc_deadline_milliseconds: 1000,
        minimum_free_bytes: MINIMUM_FREE_BYTES,
    }
}
fn write(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
fn write_config(root: &Path, config: &RecoveryNodeConfig) -> PathBuf {
    let path = root.join("recovery.json");
    write(&path, &serde_json::to_vec(config).unwrap());
    path
}
fn no_stores(root: &Path) {
    for name in [
        "control",
        "material",
        "identity",
        "data",
        "logs",
        "uploads",
        "jwt_secret",
    ] {
        assert!(!root.join(name).exists(), "unexpected {name}");
    }
}

#[test]
fn loads_exact_private_operator_config_without_creating_stores_or_keys() {
    let root = private_root();
    let value = config(root.path());
    let path = write_config(root.path(), &value);
    let inode = fs::metadata(&path).unwrap().ino();
    let loaded = load(&path).unwrap();
    assert_eq!(loaded.binding, value.binding);
    assert_eq!(loaded.peers, value.peers);
    assert!(!loaded.initialize);
    assert_eq!(loaded.work_timeout, Duration::from_secs(10));
    assert_eq!(loaded.control_limits.min_free_bytes, MINIMUM_FREE_BYTES);
    assert_eq!(loaded.material_limits.min_free_bytes, MINIMUM_FREE_BYTES);
    assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
    no_stores(root.path());
}

#[test]
fn schema_unknown_duplicate_and_noncanonical_roster_fields_refuse_before_stores() {
    let root = private_root();
    let value = config(root.path());
    let valid = serde_json::to_value(&value).unwrap();
    for (field, bad) in [
        ("schemaVersion", serde_json::json!(2)),
        ("workTimeoutSeconds", serde_json::json!(0)),
        ("rpcDeadlineMilliseconds", serde_json::json!(6000)),
        ("minimumFreeBytes", serde_json::json!(0)),
        ("initialize", serde_json::json!(true)),
        ("sourceNodeId", serde_json::json!("")),
        ("writerPermitted", serde_json::json!(true)),
    ] {
        let mut changed = valid.clone();
        changed[field] = bad;
        let path = root.path().join("recovery.json");
        write(&path, &serde_json::to_vec(&changed).unwrap());
        assert_eq!(
            load(&path).err(),
            Some(RecoveryNodeError::Configuration),
            "{field}"
        );
        no_stores(root.path());
    }
    let mut changed = valid.clone();
    let peers = changed["peers"].as_object_mut().unwrap();
    let first = peers.remove("1").unwrap();
    peers.insert("01".into(), first);
    let path = root.path().join("recovery.json");
    write(&path, &serde_json::to_vec(&changed).unwrap());
    assert_eq!(load(&path).err(), Some(RecoveryNodeError::Configuration));
    let first = serde_json::to_string(&value.peers[&1]).unwrap();
    let mut duplicate = serde_json::to_string(&value).unwrap();
    duplicate = duplicate.replacen("\"peers\":{", &format!("\"peers\":{{\"1\":{first},"), 1);
    write(&path, duplicate.as_bytes());
    assert_eq!(load(&path).err(), Some(RecoveryNodeError::Configuration));
    let mut duplicate = serde_json::to_string(&value).unwrap();
    duplicate.pop();
    duplicate.push_str(",\"schemaVersion\":1}");
    write(&path, duplicate.as_bytes());
    assert_eq!(load(&path).err(), Some(RecoveryNodeError::Configuration));
    no_stores(root.path());
}

#[test]
fn unsafe_files_parents_links_paths_and_oversized_input_refuse_without_chmod() {
    let root = private_root();
    let path = write_config(root.path(), &config(root.path()));
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(load(&path).err(), Some(RecoveryNodeError::Ownership));
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o644);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let link = root.path().join("alias.json");
    symlink(&path, &link).unwrap();
    assert_eq!(load(&link).err(), Some(RecoveryNodeError::Ownership));
    let hard = root.path().join("hard.json");
    fs::hard_link(&path, &hard).unwrap();
    assert_eq!(load(&path).err(), Some(RecoveryNodeError::Ownership));
    fs::remove_file(hard).unwrap();
    assert_eq!(
        load(Path::new("recovery.json")).err(),
        Some(RecoveryNodeError::Ownership)
    );
    let dotted = PathBuf::from(format!("{}/./recovery.json", root.path().display()));
    assert_eq!(load(&dotted).err(), Some(RecoveryNodeError::Ownership));
    let oversized = vec![b' '; MAX_CONFIG_BYTES as usize + 1];
    write(&path, &oversized);
    assert_eq!(load(&path).err(), Some(RecoveryNodeError::Ownership));
    write_config(root.path(), &config(root.path()));
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(load(&path).err(), Some(RecoveryNodeError::Ownership));
    assert_eq!(fs::metadata(root.path()).unwrap().mode() & 0o777, 0o755);
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    no_stores(root.path());
}

#[tokio::test]
async fn shutdown_before_startup_reads_only_and_opens_no_store() {
    let root = private_root();
    let path = write_config(root.path(), &config(root.path()));
    run(path, std::future::ready(())).await.unwrap();
    no_stores(root.path());
}
