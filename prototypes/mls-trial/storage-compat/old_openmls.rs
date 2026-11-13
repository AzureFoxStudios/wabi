//! Old OpenMLS release: `write <dir>` creates a two-device group and saves state + a message;
//! `verify <dir>` reloads Bob (same old release) and reads the reply written by the current release.
use openmls::prelude::tls_codec::{Deserialize as _, Serialize as _};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use std::fs;

const CS: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

fn dev(name: &str) -> (OpenMlsRustCrypto, SignatureKeyPair, CredentialWithKey) {
    let p = OpenMlsRustCrypto::default();
    let s = SignatureKeyPair::new(CS.signature_algorithm()).unwrap();
    s.store(p.storage()).unwrap();
    let c = CredentialWithKey { credential: BasicCredential::new(name.as_bytes().to_vec()).into(), signature_key: s.public().into() };
    (p, s, c)
}
fn dump(p: &OpenMlsRustCrypto) -> String {
    let v: Vec<(Vec<u8>, Vec<u8>)> = p.storage().values.read().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    serde_json::to_string(&v).unwrap()
}
fn undump(s: &str) -> OpenMlsRustCrypto {
    let v: Vec<(Vec<u8>, Vec<u8>)> = serde_json::from_str(s).unwrap();
    let p = OpenMlsRustCrypto::default();
    p.storage().values.write().unwrap().extend(v);
    p
}
fn decrypt(p: &OpenMlsRustCrypto, g: &mut MlsGroup, b: &[u8]) -> String {
    let m = MlsMessageIn::tls_deserialize_exact(b).unwrap().try_into_protocol_message().unwrap();
    match g.process_message(p, m).unwrap().into_content() {
        ProcessedMessageContent::ApplicationMessage(a) => String::from_utf8(a.into_bytes()).unwrap(),
        _ => panic!("not an application message"),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = &args[2];
    let ver = env!("CARGO_PKG_NAME");
    match args[1].as_str() {
        "write" => {
            let (pa, sa, ca) = dev("alice");
            let (pb, sb, cb) = dev("bob");
            let cfg = MlsGroupCreateConfig::builder().ciphersuite(CS).use_ratchet_tree_extension(true).build();
            let mut ga = MlsGroup::new(&pa, &sa, &cfg, ca).unwrap();
            let kp = KeyPackage::builder().build(CS, &pb, &sb, cb).unwrap();
            let (_c, w, _) = ga.add_members(&pa, &sa, &[kp.key_package().clone()]).unwrap();
            ga.merge_pending_commit(&pa).unwrap();
            let w = MlsMessageIn::tls_deserialize_exact(&w.tls_serialize_detached().unwrap()).unwrap();
            let MlsMessageBodyIn::Welcome(w) = w.extract() else { panic!() };
            let mut gb = StagedWelcome::new_from_welcome(&pb, cfg.join_config(), w, None).unwrap().into_group(&pb).unwrap();
            let m = ga.create_message(&pa, &sa, b"warm-up").unwrap();
            assert_eq!(decrypt(&pb, &mut gb, &m.tls_serialize_detached().unwrap()), "warm-up");
            let m0 = gb.create_message(&pb, &sb, format!("written by {ver}").as_bytes()).unwrap();
            fs::write(format!("{dir}/alice.json"), dump(&pa)).unwrap();
            fs::write(format!("{dir}/bob.json"), dump(&pb)).unwrap();
            fs::write(format!("{dir}/gid.bin"), ga.group_id().as_slice()).unwrap();
            fs::write(format!("{dir}/m0.bin"), m0.tls_serialize_detached().unwrap()).unwrap();
            println!("{ver}: wrote alice's state ({} bytes as JSON) and a message from bob", dump(&pa).len());
        }
        "verify" => {
            let pb = undump(&fs::read_to_string(format!("{dir}/bob.json")).unwrap());
            let gid = GroupId::from_slice(&fs::read(format!("{dir}/gid.bin")).unwrap());
            let mut gb = MlsGroup::load(pb.storage(), &gid).unwrap().unwrap();
            let m1 = fs::read(format!("{dir}/m1.bin")).unwrap();
            println!("{ver}: bob read the reply from the upgraded alice: {:?}", decrypt(&pb, &mut gb, &m1));
        }
        _ => panic!("write|verify"),
    }
}
