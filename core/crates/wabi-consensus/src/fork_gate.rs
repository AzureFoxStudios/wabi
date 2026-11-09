//! Test-only gate between child-process spawns and in-process flock
//! acquisition in this crate's unit-test binary.
//!
//! Store, MaterialStore and runtime roots own their files through `flock`,
//! which belongs to the open file description. Creating a child copies the
//! whole fd table, and the child keeps every description that was open at
//! that moment alive until it closes its copies. A store dropped by another
//! test meanwhile is then still locked, and an immediate reopen or lock probe
//! is refused although this process released everything. Several tests spawn
//! children from this same binary, so other tests used to see phantom owners.
//!
//! Returning from `Command::spawn` is not enough on its own: the kernel wakes
//! the parent during execve before O_CLOEXEC descriptors are closed. So the
//! child closes its inherited regular-file descriptors (the only kind that
//! carries a flock here) itself, before exec, and `spawn` holds the gate
//! exclusively until `Command::spawn` returns. Lock acquisition holds the
//! gate shared, so the flock state it observes reflects only real owners.
//! Real contention and every refusal path are unchanged.
use std::{
    fs, io,
    os::unix::process::CommandExt,
    process::{Child, Command},
    sync::{RwLock, RwLockReadGuard},
};

static GATE: RwLock<()> = RwLock::new(());

/// Hold while acquiring (or probing) a flock in this process, and while
/// opening or duplicating a descriptor for a lock-bearing file.
pub(crate) fn acquire() -> RwLockReadGuard<'static, ()> {
    GATE.read().unwrap_or_else(|e| e.into_inner())
}

/// Spawn a child that cannot carry this process's flocks past `spawn`.
pub(crate) fn spawn(command: &mut Command) -> io::Result<Child> {
    let _exclusive = GATE.write().unwrap_or_else(|e| e.into_inner());
    // Every lock-bearing descriptor is opened or duplicated under `acquire`,
    // so none can appear while this is held: all are numbered <= `highest`.
    let highest = fs::read_dir("/proc/self/fd")?
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<i32>().ok())
        .max()
        .unwrap_or(2);
    // SAFETY: the hook runs in the forked child before exec and only calls
    // the async-signal-safe fstat and close on descriptors it may own.
    // std has already installed stdio, and its exec-status pipe is not a
    // regular file, so spawn error reporting is unaffected.
    unsafe {
        command.pre_exec(move || {
            for fd in 3..=highest {
                let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
                if libc::fstat(fd, stat.as_mut_ptr()) == 0
                    && stat.assume_init().st_mode & libc::S_IFMT == libc::S_IFREG
                {
                    libc::close(fd);
                }
            }
            Ok(())
        });
    }
    command.spawn()
}
