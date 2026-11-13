//! Old mls-rs release: `write <dir>` creates a two-device group and saves state + a message;
//! `verify <dir>` reloads Bob (same old release) and reads the reply written by the current release.
use mls_rs::{
    client_builder::MlsConfig,
    identity::{basic::{BasicCredential, BasicIdentityProvider}, SigningIdentity},
    mls_rs_codec::MlsEncode,
    group::ReceivedMessage,
    storage_provider::in_memory::InMemoryGroupStateStorage,
    CipherSuite, CipherSuiteProvider, Client, CryptoProvider, ExtensionList, MlsMessage,
};
use mls_rs::mls_rules::{CommitOptions, DefaultMlsRules};
use mls_rs_core::{crypto::SignatureSecretKey, group::{EpochRecord, GroupState, GroupStateStorage}};
use std::fs;

const CS: CipherSuite = CipherSuite::CURVE25519_AES128;

fn client(sk: SignatureSecretKey, si: SigningIdentity, st: InMemoryGroupStateStorage) -> Client<impl MlsConfig> {
    Client::builder()
        .identity_provider(BasicIdentityProvider)
        .crypto_provider(mls_rs_crypto_rustcrypto::RustCryptoProvider::default())
        .group_state_storage(st)
        .mls_rules(DefaultMlsRules::new().with_commit_options(CommitOptions::new()))
        .signing_identity(si, sk, CS)
        .build()
}
fn ident(name: &str) -> (SignatureSecretKey, SigningIdentity) {
    let csp = mls_rs_crypto_rustcrypto::RustCryptoProvider::default().cipher_suite_provider(CS).unwrap();
    let (sk, pk) = csp.signature_key_generate().unwrap();
    (sk, SigningIdentity::new(BasicCredential::new(name.as_bytes().to_vec()).into_credential(), pk))
}
fn save(dir: &str, who: &str, st: &InMemoryGroupStateStorage, gid: &[u8], sk: &SignatureSecretKey, si: &SigningIdentity) -> usize {
    let state = st.state(gid).unwrap().unwrap();
    let max = st.max_epoch_id(gid).unwrap().unwrap_or(0);
    let mut ep = vec![];
    for id in 0..=max {
        if let Some(b) = st.epoch(gid, id).unwrap() {
            ep.extend_from_slice(&id.to_be_bytes());
            ep.extend_from_slice(&(b.len() as u32).to_be_bytes());
            ep.extend_from_slice(&b);
        }
    }
    fs::write(format!("{dir}/{who}_state.bin"), &*state).unwrap();
    fs::write(format!("{dir}/{who}_epochs.bin"), &ep).unwrap();
    fs::write(format!("{dir}/{who}_sk.bin"), sk.as_bytes()).unwrap();
    fs::write(format!("{dir}/{who}_si.bin"), si.mls_encode_to_vec().unwrap()).unwrap();
    state.len() + ep.len()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = &args[2];
    let ver = env!("CARGO_PKG_NAME");
    match args[1].as_str() {
        "write" => {
            let (ska, sia) = ident("alice");
            let (skb, sib) = ident("bob");
            let (sta, stb) = (InMemoryGroupStateStorage::new(), InMemoryGroupStateStorage::new());
            let a = client(ska.clone(), sia.clone(), sta.clone());
            let b = client(skb.clone(), sib.clone(), stb.clone());
            let mut ga = a.create_group(ExtensionList::default(), Default::default(), None).unwrap();
            let kp = b.generate_key_package_message(Default::default(), Default::default(), None).unwrap();
            let out = ga.commit_builder().add_member(kp).unwrap().build().unwrap();
            ga.apply_pending_commit().unwrap();
            let (mut gb, _) = b.join_group(None, &out.welcome_messages[0], None).unwrap();
            let m = ga.encrypt_application_message(b"warm-up", vec![]).unwrap();
            gb.process_incoming_message(m).unwrap();
            let m0 = gb.encrypt_application_message(format!("written by {ver}").as_bytes(), vec![]).unwrap();
            ga.write_to_storage().unwrap();
            gb.write_to_storage().unwrap();
            let gid = ga.group_id().to_vec();
            let n = save(dir, "alice", &sta, &gid, &ska, &sia);
            save(dir, "bob", &stb, &gid, &skb, &sib);
            fs::write(format!("{dir}/gid.bin"), &gid).unwrap();
            fs::write(format!("{dir}/m0.bin"), m0.to_bytes().unwrap()).unwrap();
            println!("{ver}: wrote alice's state ({n} bytes) and a message from bob");
        }
        "verify" => {
            let gid = fs::read(format!("{dir}/gid.bin")).unwrap();
            let st = InMemoryGroupStateStorage::new();
            let mut st2 = st.clone();
            let mut eps = vec![];
            let raw = fs::read(format!("{dir}/bob_epochs.bin")).unwrap();
            let mut i = 0;
            while i < raw.len() {
                let id = u64::from_be_bytes(raw[i..i + 8].try_into().unwrap());
                let n = u32::from_be_bytes(raw[i + 8..i + 12].try_into().unwrap()) as usize;
                eps.push(EpochRecord::new(id, raw[i + 12..i + 12 + n].to_vec().into()));
                i += 12 + n;
            }
            st2.write(GroupState { id: gid.clone(), data: fs::read(format!("{dir}/bob_state.bin")).unwrap().into() }, eps, vec![]).unwrap();
            use mls_rs::mls_rs_codec::MlsDecode;
            let si = SigningIdentity::mls_decode(&mut &*fs::read(format!("{dir}/bob_si.bin")).unwrap()).unwrap();
            let sk = SignatureSecretKey::new(fs::read(format!("{dir}/bob_sk.bin")).unwrap());
            let b = client(sk, si, st);
            let mut gb = b.load_group(&gid).unwrap();
            let m1 = MlsMessage::from_bytes(&fs::read(format!("{dir}/m1.bin")).unwrap()).unwrap();
            match gb.process_incoming_message(m1).unwrap() {
                ReceivedMessage::ApplicationMessage(a) => println!("{ver}: bob read the reply from the upgraded alice: {:?}", String::from_utf8_lossy(a.data())),
                _ => panic!("not an application message"),
            }
        }
        _ => panic!("write|verify"),
    }
}
