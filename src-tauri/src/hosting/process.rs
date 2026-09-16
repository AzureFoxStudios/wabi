//! Own exactly one child. Never kill by port, process name, or saved PID.
use std::io;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

pub struct OwnedServer {
    child: Child,
}

impl OwnedServer {
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        Ok(Self { child: command.spawn()? })
    }
    pub fn pid(&self) -> u32 { self.child.id() }
    pub fn output(&mut self) -> Option<std::process::ChildStdout> { self.child.stdout.take() }
    pub fn exited(&mut self) -> io::Result<Option<ExitStatus>> { self.child.try_wait() }

    /// Returns true only for a successful graceful exit. A forced stop is not
    /// a backup boundary. Keep ownership until wait has reaped the child.
    pub fn stop(&mut self, timeout: Duration) -> io::Result<bool> {
        drop(self.child.stdin.take());
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait()? { return Ok(status.success()); }
            if Instant::now() >= deadline {
                self.child.kill()?;
                self.child.wait()?;
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}
impl Drop for OwnedServer {
    fn drop(&mut self) {
        // Last-resort exception cleanup; normal quit uses stop() first.
        drop(self.child.stdin.take());
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    fn fixture(mode: &str) -> OwnedServer {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["child_fixture", "--nocapture"])
            .env("WABI_PROCESS_FIXTURE", mode);
        OwnedServer::spawn(&mut command).unwrap()
    }
    #[test]
    fn child_fixture() {
        match std::env::var("WABI_PROCESS_FIXTURE").as_deref() {
            Ok("graceful") => {
                println!("fixture-ready"); std::io::stdout().flush().unwrap();
                std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink()).unwrap();
            },
            Ok("stubborn") => loop { std::thread::sleep(Duration::from_secs(1)); },
            _ => {}
        }
    }
    #[test]
    fn closes_stdin_and_reaps_graceful_child() {
        let mut child = fixture("graceful");
        let output = BufReader::new(child.output().unwrap());
        assert!(output.lines().any(|line| line.unwrap().contains("fixture-ready")));
        assert!(child.stop(Duration::from_secs(5)).unwrap());
        assert!(child.exited().unwrap().unwrap().success());
    }
    #[test]
    fn forced_stop_is_not_reported_clean() {
        let mut child = fixture("stubborn");
        assert!(!child.stop(Duration::from_millis(100)).unwrap());
        assert!(child.exited().unwrap().is_some());
    }
    #[test]
    fn missing_binary_is_an_error() {
        assert!(OwnedServer::spawn(&mut Command::new("/not/a/wabi/binary")).is_err());
    }
}
