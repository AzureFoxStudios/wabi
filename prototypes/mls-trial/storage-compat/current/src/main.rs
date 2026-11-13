//! Current releases (OpenMLS 0.9.2, mls-rs 0.57.1): load Alice's state written by an older
//! release, read Bob's message (written by the older release), reply for Bob to read.
use std::fs;

fn openmls(dir: &str) -> Result<String, String> {
    use openmls::prelude::tls_codec::{Deserialize as _, Serialize as _};
    use openmls::prelude::*;
    use openmls_rust_crypto::OpenMlsRustCrypto;
    let v: Vec<(Vec<u8>, Vec<u8>)> = serde_json::from_str(&fs::read_to_string(format!("{dir}/alice.json")).unwrap()).unwrap();
    let p = OpenMlsRustCrypto::default();
    p.storage().values.write().unwrap().extend(v);
    let gid = GroupId::from_slice(&fs::read(format!("{dir}/gid.bin")).unwrap());
    let mut g = MlsGroup::load(p.storage(), &gid).map_err(|e| format!("load failed: {e:?}"))?.ok_or("load returned no group")?;
    let m0 = MlsMessageIn::tls_deserialize_exact(&fs::read(format!("{dir}/m0.bin")).unwrap()).unwrap().try_into_protocol_message().unwrap();
    let read = match g.process_message(&p, m0).map_err(|e| format!("decrypt of old message failed: {e:?}"))?.into_content() {
        ProcessedMessageContent::ApplicationMessage(a) => String::from_utf8(a.into_bytes()).unwrap(),
        _ => return Err("not an application message".into()),
    };
    // The signer was stored by the old release too; find it by the leaf's public key.
    let pk = g.own_leaf().unwrap().signature_key().as_slice().to_vec();
    let signer = openmls_basic_credential_new::SignatureKeyPair::read(p.storage(), &pk, g.ciphersuite().signature_algorithm()).ok_or("signer not found in old storage")?;
    let m1 = g.create_message(&p, &signer, b"reply from OpenMLS 0.9.2").map_err(|e| format!("{e:?}"))?;
    fs::write(format!("{dir}/m1.bin"), m1.tls_serialize_detached().unwrap()).unwrap();
    Ok(read)
}

fn mlsrs(dir: &str) -> Result<String, String> {
    use mls_rs::{identity::{basic::BasicIdentityProvider, SigningIdentity}, mls_rs_codec::MlsDecode, group::ReceivedMessage, storage_provider::in_memory::InMemoryGroupStateStorage, CipherSuite, Client, MlsMessage};
    use mls_rs_core::{crypto::SignatureSecretKey, group::{EpochRecord, GroupState, GroupStateStorage}};
    let gid = fs::read(format!("{dir}/gid.bin")).unwrap();
    let st = InMemoryGroupStateStorage::new();
    let mut st2 = st.clone();
    let raw = fs::read(format!("{dir}/alice_epochs.bin")).unwrap();
    let (mut i, mut eps) = (0, vec![]);
    while i < raw.len() {
        let id = u64::from_be_bytes(raw[i..i + 8].try_into().unwrap());
        let n = u32::from_be_bytes(raw[i + 8..i + 12].try_into().unwrap()) as usize;
        eps.push(EpochRecord::new(id, raw[i + 12..i + 12 + n].to_vec().into()));
        i += 12 + n;
    }
    st2.write(GroupState { id: gid.clone(), data: fs::read(format!("{dir}/alice_state.bin")).unwrap().into() }, eps, vec![]).map_err(|e| format!("{e:?}"))?;
    let si = SigningIdentity::mls_decode(&mut &*fs::read(format!("{dir}/alice_si.bin")).unwrap()).map_err(|e| format!("{e:?}"))?;
    let sk = SignatureSecretKey::new(fs::read(format!("{dir}/alice_sk.bin")).unwrap());
    let c = Client::builder()
        .identity_provider(BasicIdentityProvider)
        .crypto_provider(mls_rs_crypto_rustcrypto::RustCryptoProvider::default())
        .group_state_storage(st)
        .signing_identity(si, sk, CipherSuite::CURVE25519_AES128)
        .build();
    let mut g = c.load_group(&gid).map_err(|e| format!("load failed: {e:?}"))?;
    let m0 = MlsMessage::from_bytes(&fs::read(format!("{dir}/m0.bin")).unwrap()).unwrap();
    let read = match g.process_incoming_message(m0).map_err(|e| format!("decrypt of old message failed: {e:?}"))? {
        ReceivedMessage::ApplicationMessage(a) => String::from_utf8_lossy(a.data()).to_string(),
        _ => return Err("not an application message".into()),
    };
    let m1 = g.encrypt_application_message(b"reply from mls-rs 0.57.1", vec![]).map_err(|e| format!("{e:?}"))?;
    fs::write(format!("{dir}/m1.bin"), m1.to_bytes().unwrap()).unwrap();
    Ok(read)
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let r = match a[1].as_str() { "openmls" => openmls(&a[2]), _ => mlsrs(&a[2]) };
    match r {
        Ok(s) => println!("current release loaded old state and read: {s:?}; wrote a reply"),
        Err(e) => { println!("current release FAILED: {e}"); std::process::exit(1) }
    }
}
