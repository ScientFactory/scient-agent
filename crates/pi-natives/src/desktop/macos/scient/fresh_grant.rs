//! macOS answers a process's Screen Recording and Accessibility checks once and
//! keeps that answer until the process exits, so a grant made while the agent
//! runs (the user picks "Later" when macOS offers to quit the app) would stay
//! refused until a restart. A new process asks afresh and is charged to the
//! same responsible app, so when this process's own answer is no, a
//! short-lived child asks again. Its preflight calls never prompt.

use std::{
	io::Read,
	process::{Command, Stdio},
	sync::{Mutex, PoisonError},
	thread,
	time::{Duration, Instant},
};

const SCRIPT: &str = r#"ObjC.import("CoreGraphics");ObjC.import("ApplicationServices");ObjC.bindFunction("CGPreflightScreenCaptureAccess",["bool",[]]);ObjC.bindFunction("AXIsProcessTrusted",["bool",[]]);[$.CGPreflightScreenCaptureAccess(),$.AXIsProcessTrusted()].map(Number).join(" ")"#;
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// A refusal is reused this long, so one computer call starts at most one
/// child however often it checks.
const RECHECK_AFTER: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
struct Grants {
	screen: bool,
	ax:     bool,
}

#[derive(Default)]
struct Fresh {
	/// A grant, once seen, holds for the life of the process.
	granted: Grants,
	checked: Option<Instant>,
}

impl Fresh {
	fn granted(
		&mut self,
		pick: fn(Grants) -> bool,
		now: Instant,
		probe: impl FnOnce() -> Grants,
	) -> bool {
		if pick(self.granted) {
			return true;
		}
		if self
			.checked
			.is_some_and(|at| now.saturating_duration_since(at) < RECHECK_AFTER)
		{
			return false;
		}
		let seen = probe();
		self.granted.screen |= seen.screen;
		self.granted.ax |= seen.ax;
		self.checked = Some(now);
		pick(self.granted)
	}
}

static FRESH: Mutex<Fresh> =
	Mutex::new(Fresh { granted: Grants { screen: false, ax: false }, checked: None });

fn fresh(pick: fn(Grants) -> bool) -> bool {
	FRESH
		.lock()
		.unwrap_or_else(PoisonError::into_inner)
		.granted(pick, Instant::now(), probe)
}

/// Screen Recording, from `in_process` or, when that says no, a fresh process.
pub(super) fn screen_recording(in_process: bool) -> bool {
	in_process || fresh(|grants| grants.screen)
}

/// Accessibility, from `in_process` or, when that says no, a fresh process.
pub(super) fn accessibility(in_process: bool) -> bool {
	in_process || fresh(|grants| grants.ax)
}

fn probe() -> Grants {
	let Ok(mut child) = Command::new("/usr/bin/osascript")
		.args(["-l", "JavaScript", "-e", SCRIPT])
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::null())
		.spawn()
	else {
		return Grants::default();
	};
	let deadline = Instant::now() + PROBE_TIMEOUT;
	loop {
		match child.try_wait() {
			Ok(Some(status)) if status.success() => break,
			Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
			_ => {
				let _ = child.kill();
				let _ = child.wait();
				return Grants::default();
			},
		}
	}
	let mut output = String::new();
	if let Some(mut stdout) = child.stdout.take() {
		let _ = stdout.read_to_string(&mut output);
	}
	parse(&output)
}

fn parse(output: &str) -> Grants {
	let mut values = output.split_whitespace().map(|value| value == "1");
	Grants { screen: values.next().unwrap_or(false), ax: values.next().unwrap_or(false) }
}

#[cfg(test)]
mod tests {
	use std::cell::Cell;

	use super::*;

	#[test]
	fn parses_the_child_answer_and_treats_anything_else_as_refused() {
		assert_eq!(parse("1 0\n"), Grants { screen: true, ax: false });
		assert_eq!(parse("0 1"), Grants { screen: false, ax: true });
		assert_eq!(parse(""), Grants::default());
	}

	#[test]
	fn asks_again_only_after_a_pause_and_keeps_a_grant() {
		let mut fresh = Fresh::default();
		let start = Instant::now();
		let probes = Cell::new(0);
		let answer = |grants: Grants| {
			let probes = &probes;
			move || {
				probes.set(probes.get() + 1);
				grants
			}
		};
		let screen = |grants: Grants| grants.screen;
		assert!(!fresh.granted(screen, start, answer(Grants::default())));
		assert!(!fresh.granted(screen, start + Duration::from_secs(1), answer(Grants::default())));
		assert_eq!(probes.get(), 1);
		let granted = Grants { screen: true, ax: false };
		assert!(fresh.granted(screen, start + RECHECK_AFTER, answer(granted)));
		assert!(fresh.granted(screen, start + RECHECK_AFTER * 5, answer(Grants::default())));
		assert_eq!(probes.get(), 2);
	}
}
