//! Throwaway mls-rs trial for ADR-0003. Not Wabi code; nothing here is reviewed.
//!
//! Same scenario and benchmark as `openmls-proto`. Written once with
//! `async`/`.await`; `maybe_async::must_be_sync` strips them for the normal
//! (sync) build. The WebCrypto build sets `--cfg mls_build_async`, which is how
//! mls-rs itself switches its whole API to async.

use mls_rs::{
    client_builder::MlsConfig,
    external_client::{builder::MlsConfig as ExternalMlsConfig, ExternalClient, ExternalGroup, ExternalReceivedMessage},
    group::{proposal::Proposal, CommitEffect, ReceivedMessage},
    identity::{
        basic::{BasicCredential, BasicIdentityProvider},
        SigningIdentity,
    },
    storage_provider::in_memory::InMemoryGroupStateStorage,
    CipherSuite, CipherSuiteProvider, Client, CryptoProvider, ExtensionList, Group, MlsMessage,
};
use mls_rs_core::{
    crypto::SignatureSecretKey,
    group::{EpochRecord, GroupState, GroupStateStorage},
};
use std::collections::HashSet;

#[cfg(not(feature = "webcrypto"))]
pub fn crypto() -> mls_rs_crypto_rustcrypto::RustCryptoProvider {
    mls_rs_crypto_rustcrypto::RustCryptoProvider::default()
}
#[cfg(not(feature = "webcrypto"))]
pub const PROVIDER: &str = "mls-rs-crypto-rustcrypto 0.23.0 (pure Rust)";

#[cfg(feature = "webcrypto")]
pub fn crypto() -> mls_rs_crypto_webcrypto::WebCryptoProvider {
    mls_rs_crypto_webcrypto::WebCryptoProvider::new()
}
#[cfg(feature = "webcrypto")]
pub const PROVIDER: &str = "mls-rs-crypto-webcrypto 0.16.0 (browser SubtleCrypto)";

fn e<E: std::fmt::Debug>(x: E) -> String {
    format!("{x:?}")
}

pub fn identity_of(s: &SigningIdentity) -> String {
    s.credential.as_basic().map(|b| String::from_utf8_lossy(b.identifier()).to_string()).unwrap_or_else(|| "<non-basic>".into())
}

pub fn make_client(sk: SignatureSecretKey, si: SigningIdentity, cs: CipherSuite, storage: InMemoryGroupStateStorage) -> Client<impl MlsConfig> {
    Client::builder()
        .identity_provider(BasicIdentityProvider)
        .crypto_provider(crypto())
        .group_state_storage(storage)
        .signing_identity(si, sk, cs)
        .build()
}

/// One device = one leaf.
pub struct Member<Cfg: MlsConfig> {
    pub name: String,
    pub cs: CipherSuite,
    pub sk: SignatureSecretKey,
    pub si: SigningIdentity,
    pub storage: InMemoryGroupStateStorage,
    pub client: Client<Cfg>,
    pub group: Option<Group<Cfg>>,
    pub cursor: usize,
}

#[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
pub async fn new_identity(name: &str, cs: CipherSuite) -> (SignatureSecretKey, SigningIdentity) {
    let csp = crypto().cipher_suite_provider(cs).expect("suite not supported by provider");
    let (sk, pk) = csp.signature_key_generate().await.expect("keygen");
    let cred = BasicCredential::new(name.as_bytes().to_vec());
    (sk, SigningIdentity::new(cred.into_credential(), pk))
}

#[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
pub async fn new_member(name: &str, cs: CipherSuite) -> Member<impl MlsConfig> {
    let (sk, si) = new_identity(name, cs).await;
    let storage = InMemoryGroupStateStorage::new();
    let client = make_client(sk.clone(), si.clone(), cs, storage.clone());
    Member { name: name.into(), cs, sk, si, storage, client, group: None, cursor: 0 }
}

impl<Cfg: MlsConfig + Clone> Member<Cfg> {
    #[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
    pub async fn key_package(&self) -> Vec<u8> {
        let kp = self.client.generate_key_package_message(Default::default(), Default::default(), None).await.expect("kp");
        kp.to_bytes().unwrap()
    }

    #[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
    pub async fn create_group(&mut self) {
        self.group = Some(self.client.create_group(ExtensionList::default(), Default::default(), None).await.expect("create"));
    }

    #[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
    pub async fn group_info(&self) -> Vec<u8> {
        self.group.as_ref().unwrap().group_info_message(true).await.unwrap().to_bytes().unwrap()
    }

    pub fn tree_bytes(&self) -> Vec<u8> {
        self.group.as_ref().unwrap().export_tree().to_bytes().unwrap()
    }

    fn g(&mut self) -> &mut Group<Cfg> {
        self.group.as_mut().expect("not in a group")
    }

    #[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
    pub async fn commit_add(&mut self, kps: &[Vec<u8>]) -> Result<(Vec<u8>, Vec<u8>), String> {
        let mut b = self.g().commit_builder();
        for kp in kps {
            b = b.add_member(MlsMessage::from_bytes(kp).map_err(e)?).map_err(e)?;
        }
        let out = b.build().await.map_err(e)?;
        Ok((out.commit_message.to_bytes().map_err(e)?, out.welcome_messages[0].to_bytes().map_err(e)?))
    }

    #[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
    pub async fn leaf_of(&self, name: &str) -> Option<u32> {
        self.group.as_ref()?.member_with_identity(name.as_bytes()).await.ok().map(|m| m.index)
    }

    #[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
    pub async fn commit_remove(&mut self, names: &[&str]) -> Result<Vec<u8>, String> {
        let mut idx = vec![];
        for n in names {
            idx.push(self.leaf_of(n).await.ok_or(format!("{n} not in group"))?);
        }
        let mut b = self.g().commit_builder();
        for i in idx {
            b = b.remove_member(i).map_err(e)?;
        }
        Ok(b.build().await.map_err(e)?.commit_message.to_bytes().map_err(e)?)
    }

    /// An empty commit carries a fresh path: the member's own keys rotate.
    #[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
    pub async fn commit_update(&mut self) -> Result<Vec<u8>, String> {
        Ok(self.g().commit(vec![]).await.map_err(e)?.commit_message.to_bytes().map_err(e)?)
    }

    #[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
    pub async fn commit_accepted(&mut self) -> Result<(), String> {
        self.g().apply_pending_commit().await.map(|_| ()).map_err(e)
    }

    pub fn commit_rejected(&mut self) {
        self.g().clear_pending_commit()
    }

    #[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
    pub async fn join(&mut self, welcome: &[u8]) -> Result<(), String> {
        let w = MlsMessage::from_bytes(welcome).map_err(e)?;
        let (g, _info) = self.client.join_group(None, &w, None).await.map_err(e)?;
        self.group = Some(g);
        Ok(())
    }

    #[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
    pub async fn encrypt(&mut self, text: &[u8]) -> Result<Vec<u8>, String> {
        self.g().encrypt_application_message(text, vec![]).await.map_err(e)?.to_bytes().map_err(e)
    }

    /// Returns plaintext for application messages. Ok(None) for commits.
    #[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
    pub async fn process(&mut self, bytes: &[u8]) -> Result<Option<Vec<u8>>, String> {
        let m = MlsMessage::from_bytes(bytes).map_err(e)?;
        let g = self.group.as_mut().ok_or("no group")?;
        match g.process_incoming_message(m).await.map_err(e)? {
            ReceivedMessage::ApplicationMessage(a) => Ok(Some(a.data().to_vec())),
            ReceivedMessage::Commit(c) => {
                if let CommitEffect::Removed { .. } = c.effect {
                    self.group = None; // we are out; mls-rs leaves cleanup to the app
                    return Err("this device was removed by that commit".into());
                }
                Ok(None)
            }
            _ => Ok(None),
        }
    }

    pub fn epoch(&self) -> u64 {
        self.group.as_ref().map(|g| g.current_epoch()).unwrap_or(0)
    }

    /// Write group state to storage and return the bytes held for this group.
    #[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
    pub async fn saved_state(&mut self) -> (Vec<u8>, Vec<(u64, Vec<u8>)>) {
        self.g().write_to_storage().await.unwrap();
        let gid = self.group.as_ref().unwrap().group_id().to_vec();
        let state = self.storage.state(&gid).await.unwrap().unwrap().to_vec();
        let max = self.storage.max_epoch_id(&gid).await.unwrap().unwrap_or(0);
        let mut epochs = vec![];
        for id in 0..=max {
            if let Some(b) = self.storage.epoch(&gid, id).await.unwrap() {
                epochs.push((id, b.to_vec()));
            }
        }
        (state, epochs)
    }
}

/// What WabiDB would do for one group: order, hold key packages, check public commits.
pub struct Ds<E: ExternalMlsConfig> {
    server: ExternalClient<E>,
    pub group: Option<ExternalGroup<E>>,
    pub log: Vec<(String, Vec<u8>)>,
    pub welcomes: Vec<Vec<u8>>,
    key_packages: Vec<(String, Vec<u8>)>,
    pub allowed: HashSet<String>,
}

pub fn new_ds() -> Ds<impl ExternalMlsConfig> {
    let server = ExternalClient::builder().identity_provider(BasicIdentityProvider).crypto_provider(crypto()).build();
    Ds { server, group: None, log: vec![], welcomes: vec![], key_packages: vec![], allowed: HashSet::new() }
}

impl<E: ExternalMlsConfig + Clone> Ds<E> {
    pub fn publish_key_package(&mut self, who: &str, kp: Vec<u8>) {
        self.key_packages.push((who.into(), kp));
    }
    pub fn claim_key_package(&mut self, who: &str) -> Option<Vec<u8>> {
        let i = self.key_packages.iter().position(|(w, _)| w == who)?;
        Some(self.key_packages.remove(i).1)
    }

    #[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
    pub async fn track_group(&mut self, group_info: &[u8]) -> Result<(), String> {
        let gi = MlsMessage::from_bytes(group_info).map_err(e)?;
        self.group = Some(self.server.observe_group(gi, None, None).await.map_err(e)?);
        Ok(())
    }

    pub fn epoch(&self) -> u64 {
        self.group.as_ref().unwrap().group_context().epoch
    }

    pub fn members(&self) -> Vec<String> {
        self.group.as_ref().unwrap().roster().members().iter().map(|m| identity_of(&m.signing_identity)).collect()
    }

    #[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
    pub async fn submit(&mut self, from: &str, bytes: Vec<u8>, welcome: Option<Vec<u8>>) -> Result<(), String> {
        let g = self.group.as_mut().ok_or("group not tracked")?;
        let m = MlsMessage::from_bytes(&bytes).map_err(e)?;
        if m.group_id() != Some(&g.group_context().group_id[..]) {
            return Err("wrong group".into());
        }
        let current = g.group_context().epoch;
        if m.epoch() != Some(current) {
            return Err(format!("stale epoch {:?} (current {current})", m.epoch()));
        }
        // Work on a copy so a refused commit leaves the server's view unchanged.
        let mut trial = self.server.load_group(g.snapshot()).await.map_err(e)?;
        match trial.process_incoming_message(m).await.map_err(|x| format!("refused: {x:?}"))? {
            ExternalReceivedMessage::Ciphertext(ct) => {
                if ct != mls_rs::group::ContentType::Application {
                    return Err("encrypted handshake refused: commits must be public".into());
                }
            }
            ExternalReceivedMessage::Commit(desc) => {
                let CommitEffect::NewEpoch(ne) = &desc.effect else { return Err("unexpected commit effect".into()) };
                for p in &ne.applied_proposals {
                    if let Proposal::Add(add) = &p.proposal {
                        let who = identity_of(add.signing_identity());
                        if !self.allowed.contains(&who) {
                            return Err(format!("commit refused: adds {who}, who is not a member in Wabi"));
                        }
                    }
                }
                *g = trial;
            }
            _ => return Err("refused".into()),
        }
        self.log.push((from.into(), bytes));
        if let Some(w) = welcome {
            self.welcomes.push(w);
        }
        Ok(())
    }
}

#[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
pub async fn catch_up<Cfg: MlsConfig + Clone, E: ExternalMlsConfig + Clone>(m: &mut Member<Cfg>, ds: &Ds<E>) -> Result<Vec<String>, String> {
    let mut out = vec![];
    while m.cursor < ds.log.len() {
        let (from, bytes) = ds.log[m.cursor].clone();
        m.cursor += 1;
        if from == m.name {
            continue;
        }
        if let Some(pt) = m.process(&bytes).await? {
            out.push(String::from_utf8_lossy(&pt).to_string());
        }
    }
    Ok(out)
}

#[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
async fn commit_via_ds<Cfg: MlsConfig + Clone, E: ExternalMlsConfig + Clone>(m: &mut Member<Cfg>, ds: &mut Ds<E>, commit: Vec<u8>, welcome: Option<Vec<u8>>) -> Result<(), String> {
    let name = m.name.clone();
    match ds.submit(&name, commit, welcome).await {
        Ok(()) => m.commit_accepted().await,
        Err(r) => {
            m.commit_rejected();
            Err(r)
        }
    }
}

macro_rules! check {
    ($log:expr, $cond:expr, $msg:expr) => {{
        let ok = $cond;
        $log.push(format!("{} {}", if ok { "PASS" } else { "FAIL" }, $msg));
        if !ok {
            return Err($log.join("\n"));
        }
    }};
}

#[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
pub async fn run_scenario(cs_id: u16) -> Result<Vec<String>, String> {
    let cs = CipherSuite::new(cs_id);
    let mut log = vec![format!("mls-rs 0.57.1, provider {PROVIDER}, suite {cs_id}")];
    let mut ds = new_ds();
    let mut m = vec![];
    for n in ["alice", "bob", "carol", "dave"] {
        let x = new_member(n, cs).await;
        ds.publish_key_package(n, x.key_package().await);
        ds.allowed.insert(n.into());
        m.push(x);
    }
    let (a, b, c, d) = (0, 1, 2, 3);

    m[a].create_group().await;
    let gi = m[a].group_info().await;
    ds.track_group(&gi).await?;
    let kps = vec![ds.claim_key_package("bob").unwrap(), ds.claim_key_package("carol").unwrap()];
    let (commit, welcome) = m[a].commit_add(&kps).await?;
    commit_via_ds(&mut m[a], &mut ds, commit, Some(welcome.clone())).await?;
    m[b].join(&welcome).await?;
    m[c].join(&welcome).await?;
    m[b].cursor = ds.log.len();
    m[c].cursor = ds.log.len();
    check!(log, ds.members() == vec!["alice", "bob", "carol"], "server tracks members alice,bob,carol from public commits only");

    for (i, text) in [(a, "hi from alice"), (b, "hi from bob"), (c, "hi from carol")] {
        let ct = m[i].encrypt(text.as_bytes()).await?;
        let name = m[i].name.clone();
        ds.submit(&name, ct, None).await?;
    }
    let got_a = catch_up(&mut m[a], &ds).await?;
    let got_b = catch_up(&mut m[b], &ds).await?;
    let got_c = catch_up(&mut m[c], &ds).await?;
    check!(log, got_a == ["hi from bob", "hi from carol"] && got_b == ["hi from alice", "hi from carol"] && got_c == ["hi from alice", "hi from bob"], "three members exchange application messages");

    let ca = m[a].commit_update().await?;
    let cb = m[b].commit_update().await?;
    commit_via_ds(&mut m[a], &mut ds, ca, None).await?;
    let race = commit_via_ds(&mut m[b], &mut ds, cb, None).await;
    check!(log, race.is_err(), format!("server refuses the losing commit of a race: {}", race.err().unwrap_or_default()));
    catch_up(&mut m[b], &ds).await?;
    catch_up(&mut m[c], &ds).await?;
    let cb2 = m[b].commit_update().await?;
    commit_via_ds(&mut m[b], &mut ds, cb2, None).await?;
    catch_up(&mut m[a], &ds).await?;
    catch_up(&mut m[c], &ds).await?;
    check!(log, m[a].epoch() == m[b].epoch() && m[b].epoch() == m[c].epoch() && m[a].epoch() == ds.epoch(), format!("loser retries after catching up; all at epoch {}", ds.epoch()));

    let mallory = new_member("mallory", cs).await;
    let mkp = mallory.key_package().await;
    let (bad, _) = m[b].commit_add(&[mkp]).await?;
    let r = commit_via_ds(&mut m[b], &mut ds, bad, None).await;
    check!(log, r.as_ref().err().map(|x| x.contains("mallory")).unwrap_or(false), format!("server refuses a commit adding a non-member, reading only public fields: {}", r.err().unwrap_or_default()));

    let bob_offline_at = m[b].cursor;
    let kp = ds.claim_key_package("dave").unwrap();
    let (commit, welcome) = m[a].commit_add(&[kp]).await?;
    commit_via_ds(&mut m[a], &mut ds, commit, Some(welcome.clone())).await?;
    m[d].join(&welcome).await?;
    m[d].cursor = ds.log.len();
    catch_up(&mut m[c], &ds).await?;
    let cu = m[c].commit_update().await?;
    commit_via_ds(&mut m[c], &mut ds, cu, None).await?;
    catch_up(&mut m[a], &ds).await?;
    catch_up(&mut m[d], &ds).await?;
    let before_removal = m[a].encrypt(b"carol can still read this").await?;
    ds.submit("alice", before_removal, None).await?;
    let carol_pos = m[c].cursor;
    let rm = m[a].commit_remove(&["carol"]).await?;
    commit_via_ds(&mut m[a], &mut ds, rm, None).await?;
    catch_up(&mut m[d], &ds).await?;
    let du = m[d].commit_update().await?;
    commit_via_ds(&mut m[d], &mut ds, du, None).await?;
    catch_up(&mut m[a], &ds).await?;
    let secret = m[a].encrypt(b"after carol left").await?;
    ds.submit("alice", secret.clone(), None).await?;
    check!(log, ds.members() == vec!["alice", "bob", "dave"], "server membership after add dave, remove carol: alice,bob,dave");

    let old_state = m[c].process(&secret).await;
    check!(log, old_state.is_err(), format!("removed member with pre-removal state cannot decrypt a later message: {}", old_state.err().unwrap_or_default().chars().take(90).collect::<String>()));
    m[c].cursor = carol_pos;
    let seen = catch_up(&mut m[c], &ds).await;
    check!(log, m[c].group.is_none(), format!("removed member who processes the log is told it was removed (catch-up result: {})", match &seen { Ok(v) => format!("read {:?}", v), Err(x) => format!("error {}", x.chars().take(80).collect::<String>()) }));

    let missed = ds.log.len() - bob_offline_at;
    let got = catch_up(&mut m[b], &ds).await?;
    check!(log, got.last().map(|s| s.as_str()) == Some("after carol left") && m[b].epoch() == ds.epoch(), format!("offline member catches up over {missed} log entries (4 commits) and reads {:?}", got));

    // Persistence: bytes out of storage, into a brand-new client, load, send.
    let (state, epochs) = m[a].saved_state().await;
    let total: usize = state.len() + epochs.iter().map(|(_, b)| b.len()).sum::<usize>();
    let gid = m[a].group.as_ref().unwrap().group_id().to_vec();
    let mut fresh = InMemoryGroupStateStorage::new();
    let records: Vec<EpochRecord> = epochs.iter().map(|(id, b)| EpochRecord::new(*id, b.clone().into())).collect();
    fresh.write(GroupState { id: gid.clone(), data: state.clone().into() }, records, vec![]).await.map_err(e)?;
    let client = make_client(m[a].sk.clone(), m[a].si.clone(), cs, fresh.clone());
    let mut reloaded = client.load_group(&gid).await.map_err(e)?;
    let ct = reloaded.encrypt_application_message(b"after reload", vec![]).await.map_err(e)?.to_bytes().map_err(e)?;
    ds.submit("alice", ct, None).await?;
    let got_d = catch_up(&mut m[d], &ds).await?;
    check!(log, got_d.last().map(|s| s.as_str()) == Some("after reload"), format!("device state saved (snapshot {} bytes + {} epoch records, {total} bytes), loaded into a new client, used to send", state.len(), epochs.len()));
    Ok(log)
}

#[derive(Default, Debug)]
pub struct Bench {
    pub n: usize,
    pub kp_gen_ms: f64,
    pub create_ms: f64,
    pub join_ms: f64,
    pub add_commit_ms: f64,
    pub add_process_ms: f64,
    pub remove_commit_ms: f64,
    pub remove_process_ms: f64,
    pub encrypt_ms: f64,
    pub decrypt_ms: f64,
    pub welcome_bytes: usize,
    pub add_commit_bytes: usize,
    pub state_bytes: usize,
}

impl Bench {
    pub fn json(&self) -> String {
        format!(
            "{{\"n\":{},\"kp_gen_ms\":{:.3},\"create_ms\":{:.3},\"join_ms\":{:.3},\"add_commit_ms\":{:.3},\"add_process_ms\":{:.3},\"remove_commit_ms\":{:.3},\"remove_process_ms\":{:.3},\"encrypt_ms\":{:.4},\"decrypt_ms\":{:.4},\"welcome_bytes\":{},\"add_commit_bytes\":{},\"state_bytes\":{}}}",
            self.n, self.kp_gen_ms, self.create_ms, self.join_ms, self.add_commit_ms, self.add_process_ms, self.remove_commit_ms, self.remove_process_ms, self.encrypt_ms, self.decrypt_ms, self.welcome_bytes, self.add_commit_bytes, self.state_bytes
        )
    }
}

#[cfg_attr(not(mls_build_async), maybe_async::must_be_sync)]
pub async fn bench(n: usize, cs_id: u16, now: &dyn Fn() -> f64) -> Result<Bench, String> {
    let cs = CipherSuite::new(cs_id);
    let mut r = Bench { n, ..Default::default() };
    let mut ms = vec![];
    for i in 0..n + 1 {
        ms.push(new_member(&format!("m{i}"), cs).await);
    }
    let t = now();
    let mut kps = vec![];
    for x in &ms[1..] {
        kps.push(x.key_package().await);
    }
    r.kp_gen_ms = (now() - t) / kps.len() as f64;
    let t = now();
    ms[0].create_group().await;
    let (_c, welcome) = ms[0].commit_add(&kps[..n - 1]).await?;
    ms[0].commit_accepted().await?;
    r.create_ms = now() - t;
    r.welcome_bytes = welcome.len();
    let t = now();
    ms[1].join(&welcome).await?;
    r.join_ms = now() - t;
    let t = now();
    let (add, w2) = ms[0].commit_add(&kps[n - 1..]).await?;
    ms[0].commit_accepted().await?;
    r.add_commit_ms = now() - t;
    r.add_commit_bytes = add.len();
    let t = now();
    ms[1].process(&add).await?;
    r.add_process_ms = now() - t;
    ms[n].join(&w2).await?;
    let t = now();
    let rm = ms[0].commit_remove(&[&format!("m{n}")]).await?;
    ms[0].commit_accepted().await?;
    r.remove_commit_ms = now() - t;
    let t = now();
    ms[1].process(&rm).await?;
    r.remove_process_ms = now() - t;
    let reps = 20;
    let mut cts = vec![];
    let t = now();
    for i in 0..reps {
        cts.push(ms[0].encrypt(format!("message {i} with some ordinary chat length text").as_bytes()).await?);
    }
    r.encrypt_ms = (now() - t) / reps as f64;
    let t = now();
    for c in &cts {
        ms[1].process(c).await?;
    }
    r.decrypt_ms = (now() - t) / reps as f64;
    let (s, ep) = ms[1].saved_state().await;
    r.state_bytes = s.len() + ep.iter().map(|(_, b)| b.len()).sum::<usize>();
    Ok(r)
}

#[cfg(any(feature = "wasm", feature = "webcrypto"))]
mod wasm {
    use wasm_bindgen::prelude::*;

    fn now() -> f64 {
        web_sys::window().unwrap().performance().unwrap().now()
    }

    #[cfg(not(mls_build_async))]
    #[wasm_bindgen]
    pub fn run_scenario(cs: u16) -> String {
        match super::run_scenario(cs) {
            Ok(l) => l.join("\n"),
            Err(l) => format!("{l}\nSCENARIO FAILED"),
        }
    }

    #[cfg(not(mls_build_async))]
    #[wasm_bindgen]
    pub fn bench(n: usize, cs: u16) -> String {
        match super::bench(n, cs, &now) {
            Ok(b) => b.json(),
            Err(x) => format!("{{\"error\":{:?}}}", x),
        }
    }

    #[cfg(mls_build_async)]
    #[wasm_bindgen]
    pub async fn run_scenario(cs: u16) -> String {
        match super::run_scenario(cs).await {
            Ok(l) => l.join("\n"),
            Err(l) => format!("{l}\nSCENARIO FAILED"),
        }
    }

    #[cfg(mls_build_async)]
    #[wasm_bindgen]
    pub async fn bench(n: usize, cs: u16) -> String {
        match super::bench(n, cs, &now).await {
            Ok(b) => b.json(),
            Err(x) => format!("{{\"error\":{:?}}}", x),
        }
    }
}
