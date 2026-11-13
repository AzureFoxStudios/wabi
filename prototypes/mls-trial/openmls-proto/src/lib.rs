//! Throwaway OpenMLS trial for ADR-0003. Not Wabi code; nothing here is reviewed.
//!
//! One scenario and one benchmark, shared by the native binary (`src/main.rs`)
//! and the browser build (`--features wasm`). A tiny in-memory "delivery
//! service" plays the part WabiDB would play: it orders messages, stores key
//! packages, and checks public commits without being able to read content.

use openmls::prelude::*;
use openmls::prelude::tls_codec::{Deserialize as _, Serialize as _};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use std::collections::{HashMap, HashSet};

pub fn suite(id: u16) -> Ciphersuite {
    Ciphersuite::try_from(id).expect("unknown ciphersuite")
}

fn e<E: std::fmt::Debug>(x: E) -> String {
    format!("{x:?}")
}

pub fn ser(m: &MlsMessageOut) -> Vec<u8> {
    m.tls_serialize_detached().expect("serialize")
}

/// One device. In MLS each device is its own leaf.
pub struct Member {
    pub name: String,
    pub cs: Ciphersuite,
    pub provider: OpenMlsRustCrypto,
    pub signer: SignatureKeyPair,
    pub cred: CredentialWithKey,
    pub group: Option<MlsGroup>,
    /// How far through the delivery-service log this device has read.
    pub cursor: usize,
}

pub fn create_config(cs: Ciphersuite) -> MlsGroupCreateConfig {
    MlsGroupCreateConfig::builder()
        .ciphersuite(cs)
        .use_ratchet_tree_extension(true)
        // Commits go out as PublicMessage so the server can check them.
        // OpenMLS's default is PURE_CIPHERTEXT (commits encrypted).
        .wire_format_policy(MIXED_PLAINTEXT_WIRE_FORMAT_POLICY)
        .build()
}

pub fn join_config() -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder()
        .use_ratchet_tree_extension(true)
        .wire_format_policy(MIXED_PLAINTEXT_WIRE_FORMAT_POLICY)
        .build()
}

pub fn identity_of(c: &Credential) -> String {
    BasicCredential::try_from(c.clone())
        .map(|b| String::from_utf8_lossy(b.identity()).to_string())
        .unwrap_or_else(|_| "<non-basic>".into())
}

impl Member {
    pub fn new(name: &str, cs: Ciphersuite) -> Self {
        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(cs.signature_algorithm()).expect("keygen");
        signer.store(provider.storage()).expect("store signer");
        let cred = CredentialWithKey {
            credential: BasicCredential::new(name.as_bytes().to_vec()).into(),
            signature_key: signer.public().into(),
        };
        Member { name: name.into(), cs, provider, signer, cred, group: None, cursor: 0 }
    }

    /// A KeyPackage, serialized as an MLSMessage (what a client uploads to the server).
    pub fn key_package(&self) -> Vec<u8> {
        let kpb = KeyPackage::builder()
            .build(self.cs, &self.provider, &self.signer, self.cred.clone())
            .expect("key package");
        ser(&MlsMessageOut::from(kpb.key_package().clone()))
    }

    pub fn create_group(&mut self) {
        let g = MlsGroup::new(&self.provider, &self.signer, &create_config(self.cs), self.cred.clone())
            .expect("create group");
        self.group = Some(g);
    }


    pub fn group_info(&mut self) -> Vec<u8> {
        let (p, s) = (&self.provider, &self.signer);
        let g = self.group.as_ref().unwrap();
        ser(&g.export_group_info(p.crypto(), s, true).expect("group info"))
    }

    pub fn ratchet_tree(&self) -> RatchetTreeIn {
        self.group.as_ref().unwrap().export_ratchet_tree().into()
    }

    /// Commit adding members from serialized key packages. Returns (commit, welcome).
    pub fn commit_add(&mut self, kps: &[Vec<u8>]) -> Result<(Vec<u8>, Vec<u8>), String> {
        let mut parsed = vec![];
        for kp in kps {
            let m = MlsMessageIn::tls_deserialize_exact(kp).map_err(e)?;
            let MlsMessageBodyIn::KeyPackage(kpi) = m.extract() else { return Err("not a key package".into()) };
            parsed.push(kpi.validate(self.provider.crypto(), ProtocolVersion::Mls10).map_err(e)?);
        }
        let (p, s) = (&self.provider, &self.signer);
        let g = self.group.as_mut().unwrap();
        let (commit, welcome, _gi) = g.add_members(p, s, &parsed).map_err(e)?;
        Ok((ser(&commit), ser(&welcome)))
    }

    pub fn leaf_of(&self, name: &str) -> Option<LeafNodeIndex> {
        self.group.as_ref()?.members().find(|m| identity_of(&m.credential) == name).map(|m| m.index)
    }

    pub fn commit_remove(&mut self, names: &[&str]) -> Result<Vec<u8>, String> {
        let idx: Vec<_> = names.iter().map(|n| self.leaf_of(n).ok_or(format!("{n} not in group"))).collect::<Result<_, _>>()?;
        let (p, s) = (&self.provider, &self.signer);
        let g = self.group.as_mut().unwrap();
        let (commit, _w, _gi) = g.remove_members(p, s, &idx).map_err(e)?;
        Ok(ser(&commit))
    }

    pub fn commit_update(&mut self) -> Result<Vec<u8>, String> {
        let (p, s) = (&self.provider, &self.signer);
        let g = self.group.as_mut().unwrap();
        let bundle = g.self_update(p, s, LeafNodeParameters::default()).map_err(e)?;
        Ok(ser(bundle.commit()))
    }

    /// The server accepted our commit: apply it.
    pub fn commit_accepted(&mut self) -> Result<(), String> {
        let p = &self.provider;
        self.group.as_mut().unwrap().merge_pending_commit(p).map_err(e)
    }

    /// The server rejected our commit (someone else's won the epoch): drop it.
    pub fn commit_rejected(&mut self) -> Result<(), String> {
        let p = &self.provider;
        self.group.as_mut().unwrap().clear_pending_commit(p.storage()).map_err(e)
    }

    pub fn join(&mut self, welcome: &[u8]) -> Result<(), String> {
        let m = MlsMessageIn::tls_deserialize_exact(welcome).map_err(e)?;
        let MlsMessageBodyIn::Welcome(w) = m.extract() else { return Err("not a welcome".into()) };
        let g = StagedWelcome::new_from_welcome(&self.provider, &join_config(), w, None)
            .map_err(e)?
            .into_group(&self.provider)
            .map_err(e)?;
        self.group = Some(g);
        Ok(())
    }

    pub fn encrypt(&mut self, text: &[u8]) -> Result<Vec<u8>, String> {
        let (p, s) = (&self.provider, &self.signer);
        let m = self.group.as_mut().unwrap().create_message(p, s, text).map_err(e)?;
        Ok(ser(&m))
    }

    /// Process one message from the log. Returns plaintext for application messages.
    pub fn process(&mut self, bytes: &[u8]) -> Result<Option<Vec<u8>>, String> {
        let m = MlsMessageIn::tls_deserialize_exact(bytes).map_err(e)?;
        let pm = m.try_into_protocol_message().map_err(e)?;
        let p = &self.provider;
        let g = self.group.as_mut().ok_or("no group")?;
        let processed = g.process_message(p, pm).map_err(e)?;
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(a) => Ok(Some(a.into_bytes())),
            ProcessedMessageContent::StagedCommitMessage(sc) => {
                g.merge_staged_commit(p, *sc).map_err(e)?;
                Ok(None)
            }
            ProcessedMessageContent::ProposalMessage(pr) => {
                g.store_pending_proposal(p.storage(), *pr).map_err(e)?;
                Ok(None)
            }
            _ => Ok(None),
        }
    }

    pub fn epoch(&self) -> u64 {
        self.group.as_ref().map(|g| g.epoch().as_u64()).unwrap_or(0)
    }

    /// Bytes this device holds in its OpenMLS storage (all groups, keys, key packages).
    pub fn stored_bytes(&self) -> (usize, usize) {
        let v = self.provider.storage().values.read().unwrap();
        (v.len(), v.iter().map(|(k, v)| k.len() + v.len()).sum())
    }
}

/// What WabiDB would do for one group: order messages, hold key packages,
/// and check public commits without the keys to read content.
pub struct Ds {
    provider: OpenMlsRustCrypto,
    pg: Option<PublicGroup>,
    /// (sender name, MLSMessage bytes), in the order the server accepted them.
    pub log: Vec<(String, Vec<u8>)>,
    pub welcomes: Vec<Vec<u8>>,
    key_packages: HashMap<String, Vec<Vec<u8>>>,
    /// Identities Wabi's own membership rules allow in this conversation.
    pub allowed: HashSet<String>,
}

impl Default for Ds {
    fn default() -> Self {
        Ds { provider: OpenMlsRustCrypto::default(), pg: None, log: vec![], welcomes: vec![], key_packages: HashMap::new(), allowed: HashSet::new() }
    }
}

impl Ds {
    pub fn publish_key_package(&mut self, who: &str, kp: Vec<u8>) {
        self.key_packages.entry(who.into()).or_default().push(kp);
    }
    /// Key packages are single use: hand one out and delete it.
    pub fn claim_key_package(&mut self, who: &str) -> Option<Vec<u8>> {
        self.key_packages.get_mut(who)?.pop()
    }

    /// The creator uploads GroupInfo + ratchet tree so the server can follow the group.
    pub fn track_group(&mut self, group_info: &[u8], tree: RatchetTreeIn) -> Result<(), String> {
        let m = MlsMessageIn::tls_deserialize_exact(group_info).map_err(e)?;
        let MlsMessageBodyIn::GroupInfo(vgi) = m.extract() else { return Err("not group info".into()) };
        let (pg, _) = PublicGroup::from_external(self.provider.crypto(), self.provider.storage(), tree, vgi, ProposalStore::new())
            .map_err(e)?;
        self.pg = Some(pg);
        Ok(())
    }

    /// Same as `track_group`, with the tree as TLS bytes (e.g. exported by another library).
    pub fn track_group_bytes(&mut self, group_info: &[u8], tree: &[u8]) -> Result<(), String> {
        let t = RatchetTreeIn::tls_deserialize_exact(tree).map_err(e)?;
        self.track_group(group_info, t)
    }

    pub fn epoch(&self) -> u64 {
        self.pg.as_ref().unwrap().group_context().epoch().as_u64()
    }

    pub fn members(&self) -> Vec<String> {
        self.pg.as_ref().unwrap().members().map(|m| identity_of(&m.credential)).collect()
    }

    /// Accept or refuse one message. This is the whole server-side rule set.
    pub fn submit(&mut self, from: &str, bytes: Vec<u8>, welcome: Option<Vec<u8>>) -> Result<(), String> {
        let pg = self.pg.as_mut().ok_or("group not tracked")?;
        let m = MlsMessageIn::tls_deserialize_exact(&bytes).map_err(e)?;
        let pm = m.try_into_protocol_message().map_err(|_| "not a protocol message".to_string())?;
        if pm.group_id() != pg.group_id() {
            return Err("wrong group".into());
        }
        let current = pg.group_context().epoch();
        match (&pm, pm.content_type()) {
            (ProtocolMessage::PrivateMessage(_), ContentType::Application) => {
                if pm.epoch() != current {
                    return Err(format!("stale epoch {} (current {})", pm.epoch().as_u64(), current.as_u64()));
                }
            }
            (ProtocolMessage::PrivateMessage(_), _) => return Err("encrypted handshake refused: commits must be public".into()),
            (ProtocolMessage::PublicMessage(_), ContentType::Commit) => {
                // Verifies signature, membership tag, epoch, and the tree/path.
                let processed = pg.process_message(self.provider.crypto(), pm).map_err(|x| format!("commit refused: {x:?}"))?;
                let ProcessedMessageContent::StagedCommitMessage(sc) = processed.into_content() else {
                    return Err("expected commit".into());
                };
                for add in sc.add_proposals() {
                    let who = identity_of(add.add_proposal().key_package().leaf_node().credential());
                    if !self.allowed.contains(&who) {
                        return Err(format!("commit refused: adds {who}, who is not a member in Wabi"));
                    }
                }
                pg.merge_commit(self.provider.storage(), *sc).map_err(e)?;
            }
            (ProtocolMessage::PublicMessage(_), ContentType::Proposal) => {
                return Err("standalone proposals not used in this trial".into());
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

/// Read everything in the log this device has not seen, skipping its own messages.
/// Returns the plaintexts in order.
pub fn catch_up(m: &mut Member, ds: &Ds) -> Result<Vec<String>, String> {
    let mut out = vec![];
    while m.cursor < ds.log.len() {
        let (from, bytes) = &ds.log[m.cursor];
        m.cursor += 1;
        if *from == m.name {
            continue;
        }
        if let Some(pt) = m.process(bytes)? {
            out.push(String::from_utf8_lossy(&pt).to_string());
        }
    }
    Ok(out)
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

/// Commit through the server: submit, then merge or clear depending on the answer.
fn commit_via_ds(m: &mut Member, ds: &mut Ds, commit: Vec<u8>, welcome: Option<Vec<u8>>) -> Result<(), String> {
    match ds.submit(&m.name.clone(), commit, welcome) {
        Ok(()) => {
            m.commit_accepted()?;
            Ok(())
        }
        Err(r) => {
            m.commit_rejected()?;
            Err(r)
        }
    }
}

pub fn run_scenario(cs_id: u16) -> Result<Vec<String>, String> {
    let cs = suite(cs_id);
    let mut log = vec![format!("OpenMLS 0.9.2, provider openmls_rust_crypto 0.6.0, suite {cs:?}")];
    let mut ds = Ds::default();
    let names = ["alice", "bob", "carol", "dave"];
    let mut m: Vec<Member> = names.iter().map(|n| Member::new(n, cs)).collect();
    for x in &m {
        ds.publish_key_package(&x.name, x.key_package());
        ds.allowed.insert(x.name.clone());
    }
    let (a, b, c, d) = (0, 1, 2, 3);

    // 1. Alice creates the group; the server starts tracking it.
    m[a].create_group();
    let gi = m[a].group_info();
    let tree = m[a].ratchet_tree();
    ds.track_group(&gi, tree)?;
    // 2. Alice adds Bob and Carol in one commit.
    let kps = vec![ds.claim_key_package("bob").unwrap(), ds.claim_key_package("carol").unwrap()];
    let (commit, welcome) = m[a].commit_add(&kps)?;
    commit_via_ds(&mut m[a], &mut ds, commit, Some(welcome.clone()))?;
    m[b].join(&welcome)?;
    m[c].join(&welcome)?;
    m[b].cursor = ds.log.len();
    m[c].cursor = ds.log.len();
    check!(log, ds.members() == vec!["alice", "bob", "carol"], "server tracks members alice,bob,carol from public commits only");

    // 3. Everyone talks.
    for (i, text) in [(a, "hi from alice"), (b, "hi from bob"), (c, "hi from carol")] {
        let ct = m[i].encrypt(text.as_bytes())?;
        ds.submit(&m[i].name.clone(), ct, None)?;
    }
    let got_a = catch_up(&mut m[a], &ds)?;
    let got_b = catch_up(&mut m[b], &ds)?;
    let got_c = catch_up(&mut m[c], &ds)?;
    check!(log, got_a == ["hi from bob", "hi from carol"] && got_b == ["hi from alice", "hi from carol"] && got_c == ["hi from alice", "hi from bob"], "three members exchange application messages");

    // 4. Two commits race for the same epoch: the server takes the first, refuses the second.
    let ca = m[a].commit_update()?;
    let cb = m[b].commit_update()?;
    commit_via_ds(&mut m[a], &mut ds, ca, None)?;
    let race = commit_via_ds(&mut m[b], &mut ds, cb, None);
    check!(log, race.is_err(), format!("server refuses the losing commit of a race: {}", race.err().unwrap_or_default()));
    catch_up(&mut m[b], &ds)?;
    catch_up(&mut m[c], &ds)?;
    let cb2 = m[b].commit_update()?;
    commit_via_ds(&mut m[b], &mut ds, cb2, None)?;
    catch_up(&mut m[a], &ds)?;
    catch_up(&mut m[c], &ds)?;
    check!(log, m[a].epoch() == m[b].epoch() && m[b].epoch() == m[c].epoch() && m[a].epoch() == ds.epoch(), format!("loser retries after catching up; all at epoch {}", ds.epoch()));

    // 5. The server refuses a commit adding someone Wabi's membership does not allow.
    let mut mallory = Member::new("mallory", cs);
    let mkp = mallory.key_package();
    let (bad, _) = m[b].commit_add(&[mkp])?;
    let r = commit_via_ds(&mut m[b], &mut ds, bad, None);
    check!(log, r.as_ref().err().map(|x| x.contains("mallory")).unwrap_or(false), format!("server refuses a commit adding a non-member, reading only public fields: {}", r.err().unwrap_or_default()));
    let _ = &mut mallory;

    // 6. Bob goes offline. Several commits and messages happen.
    let bob_offline_at = m[b].cursor;
    let kp = ds.claim_key_package("dave").unwrap();
    let (commit, welcome) = m[a].commit_add(&[kp])?;
    commit_via_ds(&mut m[a], &mut ds, commit, Some(welcome.clone()))?;
    m[d].join(&welcome)?;
    m[d].cursor = ds.log.len();
    catch_up(&mut m[c], &ds)?;
    let cu = m[c].commit_update()?;
    commit_via_ds(&mut m[c], &mut ds, cu, None)?;
    catch_up(&mut m[a], &ds)?;
    catch_up(&mut m[d], &ds)?;
    let before_removal = m[a].encrypt(b"carol can still read this")?;
    ds.submit("alice", before_removal, None)?;
    let carol_pos = m[c].cursor;
    let rm = m[a].commit_remove(&["carol"])?;
    commit_via_ds(&mut m[a], &mut ds, rm, None)?;
    catch_up(&mut m[d], &ds)?;
    let du = m[d].commit_update()?;
    commit_via_ds(&mut m[d], &mut ds, du, None)?;
    catch_up(&mut m[a], &ds)?;
    let secret = m[a].encrypt(b"after carol left")?;
    ds.submit("alice", secret.clone(), None)?;
    check!(log, ds.members() == vec!["alice", "bob", "dave"], "server membership after add dave, remove carol: alice,bob,dave");

    // 7. Carol, removed, cannot read later messages: neither with her old state, nor after processing her removal.
    let old_state = m[c].process(&secret);
    check!(log, old_state.is_err(), format!("removed member with pre-removal state cannot decrypt a later message: {}", old_state.err().unwrap_or_default().chars().take(90).collect::<String>()));
    m[c].cursor = carol_pos;
    let seen = catch_up(&mut m[c], &ds);
    let still_member = m[c].group.as_ref().map(|g| g.is_active()).unwrap_or(false);
    check!(log, !still_member, format!("removed member who processes the log ends inactive (catch-up result: {})", match &seen { Ok(v) => format!("read {:?} then stopped", v), Err(x) => format!("error {}", x.chars().take(80).collect::<String>()) }));

    // 8. Bob comes back after missing 4 commits and catches up in order.
    let missed = ds.log.len() - bob_offline_at;
    let got = catch_up(&mut m[b], &ds)?;
    check!(log, got.last().map(|s| s.as_str()) == Some("after carol left") && m[b].epoch() == ds.epoch(), format!("offline member catches up over {missed} log entries (4 commits) and reads {:?}", got));

    // 9. Persistence: Alice's whole device state out to bytes and back.
    let (entries, bytes) = m[a].stored_bytes();
    let saved: Vec<(Vec<u8>, Vec<u8>)> = m[a].provider.storage().values.read().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let gid = m[a].group.as_ref().unwrap().group_id().clone();
    let fresh = OpenMlsRustCrypto::default();
    fresh.storage().values.write().unwrap().extend(saved);
    let reloaded = MlsGroup::load(fresh.storage(), &gid).map_err(e)?.ok_or("group missing after reload")?;
    m[a].provider = fresh;
    m[a].group = Some(reloaded);
    let ct = m[a].encrypt(b"after reload")?;
    ds.submit("alice", ct, None)?;
    let got_d = catch_up(&mut m[d], &ds)?;
    check!(log, got_d.last().map(|s| s.as_str()) == Some("after reload"), format!("device state saved ({entries} storage entries, {bytes} bytes), reloaded, and used to send"));
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

/// Library cost only (no delivery service). Group of `n`: one creator adds n-1
/// members in a single commit. Then, at size n, one add and one remove.
pub fn bench(n: usize, cs_id: u16, now: &dyn Fn() -> f64) -> Result<Bench, String> {
    let cs = suite(cs_id);
    let mut r = Bench { n, ..Default::default() };
    let mut ms: Vec<Member> = (0..n + 1).map(|i| Member::new(&format!("m{i}"), cs)).collect();
    let t = now();
    let kps: Vec<Vec<u8>> = ms[1..].iter().map(|x| x.key_package()).collect();
    r.kp_gen_ms = (now() - t) / kps.len() as f64;
    let t = now();
    ms[0].create_group();
    let (_c, welcome) = ms[0].commit_add(&kps[..n - 1])?;
    ms[0].commit_accepted()?;
    r.create_ms = now() - t;
    r.welcome_bytes = welcome.len();
    let t = now();
    ms[1].join(&welcome)?;
    r.join_ms = now() - t;
    // add member n (the spare)
    let t = now();
    let (add, w2) = ms[0].commit_add(&kps[n - 1..])?;
    ms[0].commit_accepted()?;
    r.add_commit_ms = now() - t;
    r.add_commit_bytes = add.len();
    let t = now();
    ms[1].process(&add)?;
    r.add_process_ms = now() - t;
    ms[n].join(&w2)?;
    let t = now();
    let rm = ms[0].commit_remove(&[&format!("m{n}")])?;
    ms[0].commit_accepted()?;
    r.remove_commit_ms = now() - t;
    let t = now();
    ms[1].process(&rm)?;
    r.remove_process_ms = now() - t;
    let reps = 20;
    let mut cts = vec![];
    let t = now();
    for i in 0..reps {
        cts.push(ms[0].encrypt(format!("message {i} with some ordinary chat length text").as_bytes())?);
    }
    r.encrypt_ms = (now() - t) / reps as f64;
    let t = now();
    for c in &cts {
        ms[1].process(c)?;
    }
    r.decrypt_ms = (now() - t) / reps as f64;
    r.state_bytes = ms[1].stored_bytes().1;
    Ok(r)
}

#[cfg(feature = "wasm")]
mod wasm {
    use wasm_bindgen::prelude::*;

    fn now() -> f64 {
        web_sys::window().unwrap().performance().unwrap().now()
    }

    #[wasm_bindgen]
    pub fn run_scenario(cs: u16) -> String {
        match super::run_scenario(cs) {
            Ok(l) => l.join("\n"),
            Err(l) => format!("{l}\nSCENARIO FAILED"),
        }
    }

    #[wasm_bindgen]
    pub fn bench(n: usize, cs: u16) -> String {
        match super::bench(n, cs, &now) {
            Ok(b) => b.json(),
            Err(x) => format!("{{\"error\":{:?}}}", x),
        }
    }
}
