//! Cross-library test for ADR-0003: OpenMLS and mls-rs devices in the same MLS group.
//! If this passes, switching libraries later is a client-library change, not a
//! protocol migration: the bytes on the wire and on the server stay the same.

use mls_rs::client_builder::MlsConfig;
use mls_rs::external_client::builder::MlsConfig as ExtCfg;

trait Dev {
    fn name(&self) -> String;
    fn lib(&self) -> &'static str;
    fn kp(&self) -> Vec<u8>;
    fn create(&mut self);
    #[allow(dead_code)]
    fn group_info(&mut self) -> Vec<u8>;
    fn add(&mut self, kps: &[Vec<u8>]) -> Result<(Vec<u8>, Vec<u8>), String>;
    fn remove(&mut self, who: &[&str]) -> Result<Vec<u8>, String>;
    fn update(&mut self) -> Result<Vec<u8>, String>;
    fn accepted(&mut self) -> Result<(), String>;
    fn rejected(&mut self);
    fn join(&mut self, w: &[u8]) -> Result<(), String>;
    fn enc(&mut self, t: &str) -> Result<Vec<u8>, String>;
    fn process(&mut self, b: &[u8]) -> Result<Option<Vec<u8>>, String>;
    fn epoch(&self) -> u64;
    fn cursor(&mut self) -> &mut usize;
}

impl Dev for openmls_proto::Member {
    fn name(&self) -> String { self.name.clone() }
    fn lib(&self) -> &'static str { "OpenMLS" }
    fn kp(&self) -> Vec<u8> { self.key_package() }
    fn create(&mut self) { self.create_group() }
    fn group_info(&mut self) -> Vec<u8> { openmls_proto::Member::group_info(self) }
    fn add(&mut self, kps: &[Vec<u8>]) -> Result<(Vec<u8>, Vec<u8>), String> { self.commit_add(kps) }
    fn remove(&mut self, who: &[&str]) -> Result<Vec<u8>, String> { self.commit_remove(who) }
    fn update(&mut self) -> Result<Vec<u8>, String> { self.commit_update() }
    fn accepted(&mut self) -> Result<(), String> { self.commit_accepted() }
    fn rejected(&mut self) { let _ = self.commit_rejected(); }
    fn join(&mut self, w: &[u8]) -> Result<(), String> { openmls_proto::Member::join(self, w) }
    fn enc(&mut self, t: &str) -> Result<Vec<u8>, String> { self.encrypt(t.as_bytes()) }
    fn process(&mut self, b: &[u8]) -> Result<Option<Vec<u8>>, String> { openmls_proto::Member::process(self, b) }
    fn epoch(&self) -> u64 { openmls_proto::Member::epoch(self) }
    fn cursor(&mut self) -> &mut usize { &mut self.cursor }
}

impl<C: MlsConfig + Clone> Dev for mlsrs_proto::Member<C> {
    fn name(&self) -> String { self.name.clone() }
    fn lib(&self) -> &'static str { "mls-rs" }
    fn kp(&self) -> Vec<u8> { self.key_package() }
    fn create(&mut self) { self.create_group() }
    fn group_info(&mut self) -> Vec<u8> { mlsrs_proto::Member::group_info(self) }
    fn add(&mut self, kps: &[Vec<u8>]) -> Result<(Vec<u8>, Vec<u8>), String> { self.commit_add(kps) }
    fn remove(&mut self, who: &[&str]) -> Result<Vec<u8>, String> { self.commit_remove(who) }
    fn update(&mut self) -> Result<Vec<u8>, String> { self.commit_update() }
    fn accepted(&mut self) -> Result<(), String> { self.commit_accepted() }
    fn rejected(&mut self) { self.commit_rejected() }
    fn join(&mut self, w: &[u8]) -> Result<(), String> { mlsrs_proto::Member::join(self, w) }
    fn enc(&mut self, t: &str) -> Result<Vec<u8>, String> { self.encrypt(t.as_bytes()) }
    fn process(&mut self, b: &[u8]) -> Result<Option<Vec<u8>>, String> { mlsrs_proto::Member::process(self, b) }
    fn epoch(&self) -> u64 { mlsrs_proto::Member::epoch(self) }
    fn cursor(&mut self) -> &mut usize { &mut self.cursor }
}

trait Server {
    fn lib(&self) -> &'static str;
    fn submit(&mut self, from: &str, b: Vec<u8>, w: Option<Vec<u8>>) -> Result<(), String>;
    fn log(&self) -> &Vec<(String, Vec<u8>)>;
    fn members(&self) -> Vec<String>;
    fn allow(&mut self, who: &str);
}

impl Server for openmls_proto::Ds {
    fn lib(&self) -> &'static str { "OpenMLS PublicGroup" }
    fn submit(&mut self, from: &str, b: Vec<u8>, w: Option<Vec<u8>>) -> Result<(), String> { openmls_proto::Ds::submit(self, from, b, w) }
    fn log(&self) -> &Vec<(String, Vec<u8>)> { &self.log }
    fn members(&self) -> Vec<String> { openmls_proto::Ds::members(self) }
    fn allow(&mut self, who: &str) { self.allowed.insert(who.into()); }
}

impl<E: ExtCfg + Clone> Server for mlsrs_proto::Ds<E> {
    fn lib(&self) -> &'static str { "mls-rs ExternalClient" }
    fn submit(&mut self, from: &str, b: Vec<u8>, w: Option<Vec<u8>>) -> Result<(), String> { mlsrs_proto::Ds::submit(self, from, b, w) }
    fn log(&self) -> &Vec<(String, Vec<u8>)> { &self.log }
    fn members(&self) -> Vec<String> { mlsrs_proto::Ds::members(self) }
    fn allow(&mut self, who: &str) { self.allowed.insert(who.into()); }
}

fn catch_up(d: &mut dyn Dev, s: &dyn Server) -> Result<Vec<String>, String> {
    let mut out = vec![];
    while *d.cursor() < s.log().len() {
        let i = *d.cursor();
        *d.cursor() += 1;
        let (from, b) = &s.log()[i];
        if *from == d.name() {
            continue;
        }
        if let Some(p) = d.process(b).map_err(|x| format!("{} ({}) failed on entry {i} from {from}: {x}", d.name(), d.lib()))? {
            out.push(String::from_utf8_lossy(&p).into());
        }
    }
    Ok(out)
}

fn commit(d: &mut dyn Dev, s: &mut dyn Server, c: Vec<u8>, w: Option<Vec<u8>>) -> Result<(), String> {
    match s.submit(&d.name(), c, w) {
        Ok(()) => d.accepted(),
        Err(x) => {
            d.rejected();
            Err(x)
        }
    }
}

macro_rules! step {
    ($log:expr, $r:expr, $msg:expr) => {{
        match $r {
            Ok(v) => {
                $log.push(format!("PASS {}", $msg));
                v
            }
            Err(x) => {
                $log.push(format!("FAIL {}: {}", $msg, x));
                return Err($log.join("\n"));
            }
        }
    }};
}

/// Four devices: alice (creator), carol and dave on one library, bob on the other.
/// The server observer is the library the creator does NOT use.
fn mixed_group(mut devs: Vec<Box<dyn Dev>>, server: &mut dyn Server, title: &str) -> Result<Vec<String>, String> {
    let mut log = vec![format!("== {title}: devices {} | server checks commits with {}", devs.iter().map(|d| format!("{}={}", d.name(), d.lib())).collect::<Vec<_>>().join(", "), server.lib())];
    for d in &devs {
        server.allow(&d.name());
    }
    let kps: Vec<Vec<u8>> = devs.iter().map(|d| d.kp()).collect();
    let (a, b, c, d) = (0, 1, 2, 3);
    devs[a].create();
    let (cm, w) = step!(log, devs[a].add(&[kps[b].clone(), kps[c].clone()]), format!("{} adds {} ({}) and {} ({}) from their key packages", devs[a].lib(), devs[b].name(), devs[b].lib(), devs[c].name(), devs[c].lib()));
    step!(log, commit(devs[a].as_mut(), server, cm, Some(w.clone())), "server accepts the creator's add commit");
    step!(log, devs[b].join(&w), format!("{} joins from a {} welcome", devs[b].lib(), devs[a].lib()));
    step!(log, devs[c].join(&w), format!("{} joins from a {} welcome", devs[c].lib(), devs[a].lib()));
    let n = server.log().len();
    *devs[b].cursor() = n;
    *devs[c].cursor() = n;
    for i in [a, b, c] {
        let text = format!("hello from {}", devs[i].lib());
        let ct = step!(log, devs[i].enc(&text), format!("{} encrypts", devs[i].name()));
        let name = devs[i].name();
        step!(log, server.submit(&name, ct, None), "server accepts application message");
    }
    for i in [a, b, c] {
        let got = step!(log, catch_up(devs[i].as_mut(), server), format!("{} ({}) decrypts the others", devs[i].name(), devs[i].lib()));
        log.push(format!("     {} read {:?}", devs[i].name(), got));
    }
    // The other library commits: an update, then adds dave and removes carol.
    let up = step!(log, devs[b].update(), format!("{} makes an update commit", devs[b].lib()));
    step!(log, commit(devs[b].as_mut(), server, up, None), "server accepts it");
    let kp_d = kps[d].clone();
    let (cm, w) = step!(log, devs[b].add(&[kp_d]), format!("{} adds {} ({})", devs[b].lib(), devs[d].name(), devs[d].lib()));
    step!(log, commit(devs[b].as_mut(), server, cm, Some(w.clone())), "server accepts it");
    step!(log, devs[d].join(&w), format!("{} joins from a {} welcome", devs[d].lib(), devs[b].lib()));
    *devs[d].cursor() = server.log().len();
    step!(log, catch_up(devs[c].as_mut(), server), "carol processes both commits");
    let rm = step!(log, devs[b].remove(&["carol"]), format!("{} removes carol ({})", devs[b].lib(), devs[c].lib()));
    step!(log, commit(devs[b].as_mut(), server, rm, None), "server accepts it");
    step!(log, catch_up(devs[a].as_mut(), server), format!("{} creator processes three commits made by {}", devs[a].lib(), devs[b].lib()));
    step!(log, catch_up(devs[d].as_mut(), server), format!("dave ({}) processes the removal made by {}", devs[d].lib(), devs[b].lib()));
    let ct = step!(log, devs[d].enc("after carol left"), "dave encrypts");
    step!(log, server.submit("dave", ct.clone(), None), "server accepts it");
    let got_a = step!(log, catch_up(devs[a].as_mut(), server), "alice reads dave");
    let got_b = step!(log, catch_up(devs[b].as_mut(), server), "bob reads dave");
    let carol = devs[c].process(&ct);
    let epochs: Vec<u64> = [a, b, d].iter().map(|&i| devs[i].epoch()).collect();
    let ok = got_a == ["after carol left"] && got_b == ["after carol left"] && carol.is_err() && epochs.iter().all(|&e| e == epochs[0]) && server.members() == ["alice", "bob", "dave"];
    log.push(format!("{} alice and bob read dave, removed carol cannot ({}), epochs {:?}, server members {:?}", if ok { "PASS" } else { "FAIL" }, carol.err().unwrap_or_default().chars().take(40).collect::<String>(), epochs, server.members()));
    if !ok {
        return Err(log.join("\n"));
    }
    Ok(log)
}

fn main() {
    let mut failed = false;
    for cs in [1u16, 2] {
        print_result(&run_a(cs), &mut failed);
        print_result(&run_b(cs), &mut failed);
    }
    if failed {
        std::process::exit(1);
    }
}

fn print_result(r: &Result<Vec<String>, String>, failed: &mut bool) {
    match r {
        Ok(l) => println!("{}\n", l.join("\n")),
        Err(l) => {
            println!("{l}\nINTEROP FAILED\n");
            *failed = true;
        }
    }
}

/// OpenMLS creator, mls-rs server observer.
fn run_a(cs: u16) -> Result<Vec<String>, String> {
    let mut alice = openmls_proto::Member::new("alice", openmls_proto::suite(cs));
    let bob = mlsrs_proto::new_member("bob", mls_rs::CipherSuite::new(cs));
    let carol = openmls_proto::Member::new("carol", openmls_proto::suite(cs));
    let dave = openmls_proto::Member::new("dave", openmls_proto::suite(cs));
    alice.create_group();
    let gi = alice.group_info();
    let mut srv = mlsrs_proto::new_ds();
    srv.track_group(&gi).map_err(|x| format!("mls-rs server could not track OpenMLS group: {x}"))?;
    let devs: Vec<Box<dyn Dev>> = vec![Box::new(PreCreated(alice)), Box::new(bob), Box::new(carol), Box::new(dave)];
    mixed_group(devs, &mut srv, &format!("suite {cs}: group created with OpenMLS"))
}

/// mls-rs creator, OpenMLS server observer.
fn run_b(cs: u16) -> Result<Vec<String>, String> {
    let mut alice = mlsrs_proto::new_member("alice", mls_rs::CipherSuite::new(cs));
    let bob = openmls_proto::Member::new("bob", openmls_proto::suite(cs));
    let carol = mlsrs_proto::new_member("carol", mls_rs::CipherSuite::new(cs));
    let dave = mlsrs_proto::new_member("dave", mls_rs::CipherSuite::new(cs));
    alice.create_group();
    let gi = alice.group_info();
    let tree = alice.tree_bytes();
    let mut srv = openmls_proto::Ds::default();
    srv.track_group_bytes(&gi, &tree).map_err(|x| format!("OpenMLS server could not track mls-rs group: {x}"))?;
    let devs: Vec<Box<dyn Dev>> = vec![Box::new(PreCreated(alice)), Box::new(bob), Box::new(carol), Box::new(dave)];
    mixed_group(devs, &mut srv, &format!("suite {cs}: group created with mls-rs"))
}

/// Wraps a device whose group already exists (so the server could start tracking it first).
struct PreCreated<D: Dev>(D);
impl<D: Dev> Dev for PreCreated<D> {
    fn name(&self) -> String { self.0.name() }
    fn lib(&self) -> &'static str { self.0.lib() }
    fn kp(&self) -> Vec<u8> { self.0.kp() }
    fn create(&mut self) {}
    fn group_info(&mut self) -> Vec<u8> { self.0.group_info() }
    fn add(&mut self, k: &[Vec<u8>]) -> Result<(Vec<u8>, Vec<u8>), String> { self.0.add(k) }
    fn remove(&mut self, w: &[&str]) -> Result<Vec<u8>, String> { self.0.remove(w) }
    fn update(&mut self) -> Result<Vec<u8>, String> { self.0.update() }
    fn accepted(&mut self) -> Result<(), String> { self.0.accepted() }
    fn rejected(&mut self) { self.0.rejected() }
    fn join(&mut self, w: &[u8]) -> Result<(), String> { self.0.join(w) }
    fn enc(&mut self, t: &str) -> Result<Vec<u8>, String> { self.0.enc(t) }
    fn process(&mut self, b: &[u8]) -> Result<Option<Vec<u8>>, String> { self.0.process(b) }
    fn epoch(&self) -> u64 { self.0.epoch() }
    fn cursor(&mut self) -> &mut usize { self.0.cursor() }
}
