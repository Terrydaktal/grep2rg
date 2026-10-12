//! Black-box qualification of the actual release executable. GNU is an
//! independent oracle; fallback comparisons never count as native searches.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const SEED: u32 = 0x728ca451;
const ERE_SEED: u32 = 0x45524531;
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
type Check = Result<(), String>;
type Group = (&'static str, fn(&mut Fixture) -> Check);

fn av(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}
fn operands(values: &[&str], paths: &[OsString]) -> Vec<OsString> {
    let mut result = av(values);
    result.extend_from_slice(paths);
    result
}
fn hash(path: &Path) -> Result<String, String> {
    let result = Command::new("/usr/bin/sha256sum")
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        return Err("sha256sum failed".into());
    }
    Ok(String::from_utf8_lossy(&result.stdout)
        .split_whitespace()
        .next()
        .ok_or("missing SHA256")?
        .to_owned())
}
#[derive(Clone, Copy, Default)]
enum Transport {
    #[default]
    Direct,
    Cursor,
    ClosedOutput,
    LimitedDescriptors,
}
impl Transport {
    fn script(self) -> Option<&'static str> {
        match self {
            Self::Direct => None,
            Self::Cursor => Some("program=$1; shift; \"$program\" \"$@\"; status=$?; printf '\\nCURSOR-TAIL\\n'; /usr/bin/cat; exit \"$status\""),
            Self::ClosedOutput => Some("set -o pipefail; program=$1; shift; \"$program\" \"$@\" | /usr/bin/head -c 1"),
            Self::LimitedDescriptors => Some("ulimit -n 64; program=$1; shift; exec \"$program\" \"$@\""),
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Cursor => "cursor",
            Self::ClosedOutput => "closed-output",
            Self::LimitedDescriptors => "limited-descriptors",
        }
    }
}
#[derive(Default)]
struct Invocation<'a> {
    input: &'a [u8],
    pipe: bool,
    locale: Option<&'a str>,
    transport: Transport,
    native: bool,
}
struct Captured {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}
struct OwnedChild(std::process::Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        // Preserve the deadline on every error path, including a failed wait or
        // capture. This group was created by this runner and cannot contain a
        // pre-existing user process.
        unsafe {
            libc::kill(-(self.0.id() as i32), libc::SIGKILL);
        }
        let _ = self.0.wait();
    }
}
fn read_bounded(mut stream: impl Read) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    stream
        .by_ref()
        .take(OUTPUT_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > OUTPUT_LIMIT {
        return Err("oracle output exceeded 8 MiB; no truncated comparison accepted".into());
    }
    Ok(bytes)
}
fn collect(
    command: &mut Command,
    input: Option<Vec<u8>>,
    timeout: Duration,
) -> Result<Captured, String> {
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = OwnedChild(command.spawn().map_err(|e| format!("spawn: {e}"))?);
    let pid = child.0.id() as i32;
    let stdout = child.0.stdout.take().unwrap();
    let stderr = child.0.stderr.take().unwrap();
    let out = thread::spawn(move || read_bounded(stdout));
    let err = thread::spawn(move || read_bounded(stderr));
    let feed = input.map(|bytes| {
        let mut stdin = child.0.stdin.take().unwrap();
        thread::spawn(move || match stdin.write_all(&bytes) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
            Err(e) => Err(e.to_string()),
        })
    });
    let started = Instant::now();
    let status = loop {
        match child.0.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if started.elapsed() < timeout => thread::sleep(Duration::from_millis(1)),
            None => {
                // Only the newly created owned group is terminated, including
                // transport helpers. Never attach to or kill an existing PID.
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                }
                let _ = child.0.wait();
                let _ = out.join();
                let _ = err.join();
                if let Some(feed) = feed {
                    let _ = feed.join();
                }
                return Err(format!(
                    "oracle child exceeded its {}-millisecond deadline; owned process group killed",
                    timeout.as_millis()
                ));
            }
        }
    };
    // Reap any transport descendants which outlive their parent so pipe reads
    // cannot hang outside the deadline. An ordinary completed search has none.
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
    if let Some(feed) = feed {
        feed.join().map_err(|_| "stdin feeder panicked")??;
    }
    let stdout = out.join().map_err(|_| "stdout reader panicked")??;
    let stderr = err.join().map_err(|_| "stderr reader panicked")??;
    Ok(Captured {
        status,
        stdout,
        stderr,
    })
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn summary(result: &Captured) -> Value {
    json!({"status":result.status.code(),"signal":result.status.signal(),"stdoutHex":hex(&result.stdout[..result.stdout.len().min(4096)]),"stderrHex":hex(&result.stderr[..result.stderr.len().min(4096)]),"stdoutBytes":result.stdout.len(),"stderrBytes":result.stderr.len()})
}
fn equivalent(a: &Captured, b: &Captured) -> bool {
    a.status == b.status && a.stdout == b.stdout && a.stderr == b.stderr
}

fn runner_self_checks() -> Result<Vec<&'static str>, String> {
    let directory = tempfile::Builder::new()
        .prefix("grep2rg-runner-self-check-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let expected = Captured {
        status: ExitStatus::from_raw(0),
        stdout: vec![0xff, b'a', 0],
        stderr: b"diagnostic\n".to_vec(),
    };
    let mut checks = Vec::new();
    for (id, actual) in [
        (
            "stdout-negative-control",
            Captured {
                status: ExitStatus::from_raw(0),
                stdout: vec![0xff, b'A', 0],
                stderr: expected.stderr.clone(),
            },
        ),
        (
            "stderr-negative-control",
            Captured {
                status: ExitStatus::from_raw(0),
                stdout: expected.stdout.clone(),
                stderr: b"other\n".to_vec(),
            },
        ),
        (
            "status-negative-control",
            Captured {
                status: ExitStatus::from_raw(256),
                stdout: expected.stdout.clone(),
                stderr: expected.stderr.clone(),
            },
        ),
        (
            "signal-negative-control",
            Captured {
                status: ExitStatus::from_raw(libc::SIGPIPE),
                stdout: expected.stdout.clone(),
                stderr: expected.stderr.clone(),
            },
        ),
    ] {
        if equivalent(&expected, &actual) {
            return Err(format!("runner accepted {id}"));
        }
        checks.push(id);
    }
    let mut command = Command::new("/usr/bin/cat");
    command.stdin(Stdio::piped());
    let raw = vec![0, 0xff, b'\n', b'\r', b'x'];
    let result = collect(&mut command, Some(raw.clone()), Duration::from_secs(1))?;
    if !result.status.success() || result.stdout != raw || !result.stderr.is_empty() {
        return Err("runner raw pipe transport changed bytes or status".into());
    }
    checks.push("raw-pipe-transport");
    let mut command = Command::new(directory.path().join("missing-executable"));
    if !collect(&mut command, None, Duration::from_secs(1)).is_err_and(|e| e.starts_with("spawn:"))
    {
        return Err("runner concealed executable launch failure".into());
    }
    checks.push("launch-failure-is-explicit");
    let mut command = Command::new("/usr/bin/head");
    command
        .args(["-c", &(OUTPUT_LIMIT + 1).to_string(), "/dev/zero"])
        .stdin(Stdio::null());
    if !collect(&mut command, None, Duration::from_secs(2))
        .is_err_and(|e| e.contains("exceeded 8 MiB"))
    {
        return Err("runner accepted truncated oversized output".into());
    }
    checks.push("output-cap-rejects-truncation");
    let child_pid = directory.path().join("owned-descendant.pid");
    let mut command = Command::new("/usr/bin/bash");
    command
        .args([
            "--noprofile",
            "--norc",
            "-c",
            "sleep 30 & printf '%s\\n' \"$!\" > \"$1\"; wait",
            "owned-runner-self-check",
        ])
        .arg(&child_pid)
        .stdin(Stdio::null());
    let started = Instant::now();
    let error = collect(&mut command, None, Duration::from_millis(200));
    if !error.is_err_and(|e| e.contains("deadline")) || started.elapsed() > Duration::from_secs(2) {
        return Err("runner failed its child timeout or cleanup deadline".into());
    }
    let pid = fs::read_to_string(child_pid)
        .map_err(|e| format!("timeout descendant witness missing: {e}"))?;
    let status_path = Path::new("/proc").join(pid.trim()).join("status");
    for _ in 0..100 {
        match fs::read_to_string(&status_path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Ok(status)
                if status
                    .lines()
                    .any(|line| line.starts_with("State:") && line.contains('Z')) =>
            {
                break
            }
            _ => thread::sleep(Duration::from_millis(1)),
        }
    }
    if fs::read_to_string(status_path).is_ok_and(|status| {
        !status
            .lines()
            .any(|line| line.starts_with("State:") && line.contains('Z'))
    }) {
        return Err("runner timeout left a live owned descendant".into());
    }
    checks.push("timeout-kills-owned-descendants");
    Ok(checks)
}

struct Fixture {
    cwd: PathBuf,
    binary: PathBuf,
    artifact_hash: String,
    seed: u32,
    comparisons: usize,
    native: usize,
    fallback: usize,
    classes: BTreeMap<String, usize>,
    case_ids: Vec<String>,
    failures: Vec<Value>,
    passed: bool,
    active_case: Option<Value>,
}
impl Fixture {
    fn new(binary: &Path, seed: u32) -> Result<Self, String> {
        let directory = tempfile::Builder::new()
            .prefix("grep2rg-rust-oracle-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let cwd = directory.keep();
        let f = Self {
            cwd,
            binary: binary.to_owned(),
            artifact_hash: hash(binary)?,
            seed,
            comparisons: 0,
            native: 0,
            fallback: 0,
            classes: BTreeMap::new(),
            case_ids: Vec::new(),
            failures: Vec::new(),
            passed: false,
            active_case: None,
        };
        for (name, data) in [
            ("hit", b"head\nneedle needle\ntail\n".as_slice()),
            ("miss", b"head\nother\ntail\n"),
            ("empty", b""),
            ("unterminated", b"head\nneedle"),
            ("nul-records", b"head\0needle\0needle other\0tail"),
            ("binary", b"head\0needle\n"),
            ("patterns", b"needle\nother\n"),
            ("empty-patterns", b""),
            ("blank-patterns", b"\n"),
            ("overlap", b"a aa aaa\nneedle needle_word (needle)\n"),
            ("CRLF", b"needle\r\nother\r\nneedle"),
            ("raw-records", b"\xffneedle\nother\nneedle\xfe"),
            ("unicode", "K\nK\nk\nİ\nI\ni\nı\nß\nẞ\n".as_bytes()),
        ] {
            f.put(name, data)?;
        }
        for dir in ["tree", "tree/.git", "tree/nested"] {
            fs::create_dir(f.cwd.join(dir)).map_err(|e| e.to_string())?;
        }
        for (name, data) in [
            ("tree/.gitignore", "*.txt\n"),
            ("tree/.hidden", "needle\n"),
            ("tree/.git/synthetic", "needle\n"),
            ("tree/a.txt", "needle\nother\n"),
            ("tree/z.txt", "other\n"),
            ("tree/nested/b.txt", "needle\n"),
        ] {
            f.put(name, data.as_bytes())?;
        }
        symlink("../hit", f.cwd.join("tree/linked-file")).map_err(|e| e.to_string())?;
        symlink("nested", f.cwd.join("tree/linked-directory")).map_err(|e| e.to_string())?;
        Ok(f)
    }
    fn put(&self, name: impl AsRef<Path>, data: impl AsRef<[u8]>) -> Check {
        fs::write(self.cwd.join(name), data).map_err(|e| e.to_string())
    }
    fn run(
        &self,
        program: &Path,
        argv: &[OsString],
        options: &Invocation<'_>,
        report: Option<&Path>,
    ) -> Result<Captured, String> {
        let mut command = if let Some(script) = options.transport.script() {
            let mut command = Command::new("/usr/bin/bash");
            command
                .args([
                    "--noprofile",
                    "--norc",
                    "-c",
                    script,
                    "owned-rust-stream-oracle",
                ])
                .arg(program)
                .args(argv);
            command
        } else {
            let mut command = Command::new(program);
            command.arg0("grep").args(argv);
            command
        };
        command.current_dir(&self.cwd).env_clear();
        command.envs(env::vars_os().filter(|(key, _)| {
            let key = key.as_bytes();
            !key.starts_with(b"GREP2RG_")
                && ![b"POSIXLY_CORRECT".as_slice(), b"GREP_OPTIONS"].contains(&key)
        }));
        command
            .env("LC_ALL", options.locale.unwrap_or("C"))
            .env("LANG", "C")
            .env("TERM", "dumb")
            .env("GREP_COLORS", "")
            .env("GREP_COLOR", "");
        if let Some(report) = report {
            command.env("GREP2RG_ENGINE_REPORT", report);
        }
        if options.pipe {
            command.stdin(Stdio::piped());
        } else {
            let path = self.cwd.join(".oracle-stdin");
            fs::write(&path, options.input).map_err(|e| e.to_string())?;
            command.stdin(File::open(path).map_err(|e| e.to_string())?);
        }
        collect(
            &mut command,
            options.pipe.then(|| options.input.to_vec()),
            Duration::from_secs(5),
        )
    }
    fn compare(
        &mut self,
        id: &str,
        argv: Vec<OsString>,
        options: Invocation<'_>,
    ) -> Result<Value, String> {
        self.active_case = Some(
            json!({"id":id,"argvHex":argv.iter().map(|a|hex(a.as_bytes())).collect::<Vec<_>>(),"cwd":self.cwd,"transport":options.transport.label(),"stdinDescriptor":if options.pipe{"pipe"}else{"seekable file"},"locale":options.locale.unwrap_or("C"),"stdinHex":hex(options.input)}),
        );
        let result = self.compare_inner(id, argv, options);
        if let Err(error) = &result {
            self.failures
                .push(json!({"case":self.active_case,"error":error}));
        }
        result
    }
    fn compare_inner(
        &mut self,
        id: &str,
        argv: Vec<OsString>,
        options: Invocation<'_>,
    ) -> Result<Value, String> {
        let report = self
            .cwd
            .join(format!(".engine-report-{}.json", self.comparisons));
        let expected = self.run(Path::new("/usr/bin/grep"), &argv, &options, None)?;
        self.active_case.as_mut().unwrap()["GNU"] = summary(&expected);
        let actual = self
            .run(&self.binary, &argv, &options, Some(&report))
            .inspect_err(|_| {
                self.preserve_capture("GNU", &expected);
            })?;
        self.active_case.as_mut().unwrap()["Rust"] = summary(&actual);
        let parsed_route = || -> Result<Value, String> {
            let route: Value = serde_json::from_slice(
                &fs::read(&report).map_err(|e| format!("{id}: missing route report: {e}"))?,
            )
            .map_err(|e| format!("{id}: malformed route report: {e}"))?;
            if !matches!(route["engine"].as_str(), Some("rust" | "gnu")) {
                return Err(format!("{id}: unknown engine route: {route}"));
            }
            Ok(route)
        };
        let route = parsed_route().inspect_err(|_| {
            self.preserve_capture("GNU", &expected);
            self.preserve_capture("Rust", &actual);
        })?;
        self.active_case.as_mut().unwrap()["route"] = route.clone();
        let engine = route["engine"].as_str().ok_or("missing engine")?;
        match engine {
            "rust" => self.native += 1,
            "gnu" => self.fallback += 1,
            _ => return Err("unknown engine route".into()),
        }
        self.comparisons += 1;
        *self.classes.entry(id.to_owned()).or_default() += 1;
        let case_id = format!("{id}/{}", self.classes[id]);
        self.case_ids.push(case_id.clone());
        if !equivalent(&actual, &expected) || (options.native && engine != "rust") {
            let witness = json!({"id":id,"caseId":case_id,"argvHex":argv.iter().map(|a|hex(a.as_bytes())).collect::<Vec<_>>(),"cwd":self.cwd,"transport":options.transport.label(),"stdinDescriptor":if options.pipe{"pipe"}else{"seekable file"},"locale":options.locale.unwrap_or("C"),"stdinHex":hex(options.input),"route":route,"GNU":summary(&expected),"Rust":summary(&actual)});
            for (name, bytes) in [
                ("GNU-stdout", &expected.stdout),
                ("GNU-stderr", &expected.stderr),
                ("Rust-stdout", &actual.stdout),
                ("Rust-stderr", &actual.stderr),
            ] {
                fs::write(
                    self.cwd
                        .join(format!("failure-{}-{name}", self.comparisons)),
                    bytes,
                )
                .map_err(|e| e.to_string())?;
            }
            self.failures.push(witness.clone());
            return Err(format!(
                "{id}: complete stdout/stderr/status or required native route differs\n{witness}"
            ));
        }
        Ok(route)
    }
    fn preserve_capture(&self, label: &str, result: &Captured) {
        // These remain in the owned failure fixture even when launch or route
        // validation fails before a normal byte-comparison witness is formed.
        for (stream, bytes) in [("stdout", &result.stdout), ("stderr", &result.stderr)] {
            let _ = fs::write(
                self.cwd.join(format!("failure-last-{label}-{stream}")),
                bytes,
            );
        }
    }
    fn parallel(&mut self, id: &str, argv: Vec<OsString>, transport: Transport) -> Check {
        let route = self.compare(
            id,
            argv,
            Invocation {
                native: true,
                transport,
                ..Invocation::default()
            },
        )?;
        if !matches!(
            route["strategy"].as_str(),
            Some("parallel-mmap" | "parallel-buffered")
        ) || route["workers"].as_u64().unwrap_or(0) <= 1
        {
            return Err(format!(
                "{id}: required real multiple-worker execution: {route}"
            ));
        }
        Ok(())
    }
    fn metrics(&self) -> Value {
        json!({"seed":format!("0x{:x}",self.seed),"comparisons":self.comparisons,"rustSearches":self.native,"gnuFallbacks":self.fallback,"classes":self.classes,"caseIds":self.case_ids,"failures":self.failures.len(),"artifactSHA256":self.artifact_hash})
    }
    fn unchanged(&self) -> Check {
        if hash(&self.binary)? != self.artifact_hash {
            return Err("release binary changed during qualification".into());
        }
        Ok(())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let report = self.cwd.join("oracle-results.json");
        let _ = fs::write(
            &report,
            serde_json::to_vec_pretty(
                &json!({"metrics":self.metrics(),"failures":self.failures,"binary":self.binary,"lastCase":self.active_case}),
            )
            .unwrap(),
        );
        println!("# {}", self.metrics());
        if self.passed && self.failures.is_empty() {
            let _ = fs::remove_dir_all(&self.cwd);
        } else {
            println!("# preserved evidence: {}", report.display());
        }
    }
}

fn measured_classes(f: &mut Fixture) -> Check {
    f.put(
        "long-record",
        format!(
            "{}needle{}\nother\n",
            "x".repeat(131072),
            "x".repeat(131072)
        ),
    )?;
    let paths = av(&[
        "tree/a.txt",
        "tree/z.txt",
        "tree/.hidden",
        "tree/nested/b.txt",
    ]);
    let classes: Vec<(&str, Vec<OsString>, bool)> = vec![
        ("recursive-count", av(&["-arcF", "needle", "tree"]), true),
        (
            "recursive-invert-count",
            av(&["-arcvF", "needle", "tree"]),
            true,
        ),
        (
            "recursive-filenames-sparse",
            av(&["-rlF", "needle", "tree"]),
            true,
        ),
        (
            "recursive-filenames-no-match",
            av(&["-rlF", "absent", "tree"]),
            true,
        ),
        (
            "explicit-count",
            operands(&["-acF", "needle"], &paths),
            true,
        ),
        (
            "explicit-filenames-sparse",
            operands(&["-lF", "needle"], &paths),
            true,
        ),
        (
            "explicit-filenames-no-match",
            operands(&["-lF", "absent"], &paths),
            true,
        ),
        (
            "single-large-count-native",
            av(&["-acF", "needle", "long-record"]),
            true,
        ),
        ("small-file-native", av(&["-nF", "needle", "hit"]), true),
        ("stdin-native", av(&["-nF", "needle"]), true),
        (
            "regex-compatible-count",
            operands(&["-acE", "(other|needle).*"], &paths),
            true,
        ),
        (
            "recursive-dense-filenames-native",
            av(&["-rlF", "needle", "tree"]),
            true,
        ),
        (
            "small-recursive-count-native",
            av(&["-arcF", "needle", "tree"]),
            true,
        ),
        (
            "many-tiny-count-native",
            av(&["-arcF", "needle", "tree"]),
            true,
        ),
        (
            "below-threshold-count-native",
            av(&["-arcF", "needle", "tree"]),
            true,
        ),
        (
            "long-record-count-native",
            av(&["-acF", "needle", "long-record"]),
            true,
        ),
        (
            "long-record-content-native",
            av(&["-anF", "needle", "long-record"]),
            true,
        ),
        ("recursive-content", av(&["-arnF", "needle", "tree"]), true),
        (
            "recursive-regex-content",
            av(&["-arnE", "needle|absent", "tree"]),
            true,
        ),
        (
            "recursive-filter-native",
            av(&["-arlF", "--include=*.txt", "needle", "tree"]),
            false,
        ),
        (
            "recursive-dereference-native",
            av(&["-arlRF", "needle", "tree"]),
            true,
        ),
        (
            "word-extraction-native",
            av(&["-aFwo", "needle", "overlap"]),
            true,
        ),
        (
            "null-records-native",
            av(&["-azFc", "needle", "nul-records"]),
            true,
        ),
        (
            "pattern-file-native",
            av(&["-acF", "-f", "patterns", "hit"]),
            true,
        ),
        ("quiet-native", av(&["-aqF", "needle", "hit"]), true),
        (
            "binary-content-native",
            av(&["-nF", "needle", "binary"]),
            false,
        ),
        (
            "unicode-folding-native",
            av(&["-aiF", "K", "unicode"]),
            false,
        ),
        (
            "context-native",
            av(&["-aF", "-C", "3", "needle", "hit"]),
            false,
        ),
    ];
    let contract: Value =
        serde_json::from_slice(include_bytes!("../../tests/rust-engine-contract.json"))
            .map_err(|e| e.to_string())?;
    for (key, native) in [
        ("nativeRequiredClasses", true),
        ("fallbackAllowedClasses", false),
    ] {
        let ids: Vec<_> = classes
            .iter()
            .filter(|c| c.2 == native)
            .map(|c| Value::from(c.0))
            .collect();
        if contract[key] != Value::Array(ids) {
            return Err(format!("class inventory disagrees with {key}"));
        }
    }
    for (id, argv, native) in classes {
        f.compare(
            id,
            argv,
            Invocation {
                native,
                pipe: id == "stdin-native",
                input: if id == "stdin-native" {
                    b"head\nneedle\ntail\n"
                } else {
                    b""
                },
                ..Invocation::default()
            },
        )?;
    }
    Ok(())
}

fn option_boundaries(f: &mut Fixture) -> Check {
    let cases: &[(&str, &[&str], Option<&str>)] = &[
        ("empty-record", &["-aF", "", "hit"], None),
        ("empty-only-matching", &["-aFo", "", "hit"], None),
        ("empty-invert", &["-aFv", "", "hit"], None),
        (
            "empty-pattern-file",
            &["-aF", "-f", "empty-patterns", "hit"],
            None,
        ),
        (
            "blank-pattern-file",
            &["-aF", "-f", "blank-patterns", "hit"],
            None,
        ),
        (
            "mixed-empty-pattern",
            &["-aFn", "-e", "absent", "-e", "", "hit"],
            None,
        ),
        (
            "regression-empty-and-nonempty-extraction",
            &["-aFo", "-e", "", "-e", "needle", "hit"],
            None,
        ),
        (
            "multi-pattern-overlap",
            &["-aFo", "-e", "a", "-e", "aa", "overlap"],
            None,
        ),
        ("ERE-longest", &["-aEo", "a|aa", "overlap"], None),
        ("ERE-longest-reverse", &["-aEo", "aa|a", "overlap"], None),
        (
            "newline-pattern",
            &["-aF", "needle\nother", "hit", "miss"],
            None,
        ),
        (
            "whole-line",
            &["-aFx", "needle", "hit", "unterminated"],
            None,
        ),
        ("word-boundary", &["-aFw", "needle", "overlap"], None),
        ("invert-word", &["-aFvw", "needle", "overlap"], None),
        ("invert-only-matching", &["-aFvo", "needle", "hit"], None),
        ("count-invert", &["-aFcv", "needle", "hit", "miss"], None),
        ("count-empty", &["-aFc", "", "empty", "hit"], None),
        (
            "files-without-match-status-hit",
            &["-FL", "needle", "hit"],
            None,
        ),
        (
            "files-without-match-status-miss",
            &["-FL", "needle", "miss"],
            None,
        ),
        (
            "files-without-match-both",
            &["-FL", "needle", "hit", "miss"],
            None,
        ),
        ("filename-nul", &["-FlZ", "needle", "hit", "miss"], None),
        ("filename-header-nul", &["-aFnHZ", "needle", "hit"], None),
        (
            "filename-suppression",
            &["-aFnh", "needle", "hit", "hit"],
            None,
        ),
        ("forced-filename", &["-aFH", "needle", "unterminated"], None),
        (
            "duplicate-operands",
            &["-aFn", "needle", "hit", "hit", "miss"],
            None,
        ),
        (
            "missing-final-newline",
            &["-aFn", "needle", "unterminated"],
            None,
        ),
        ("empty-input", &["-aFc", "needle", "empty"], None),
        ("CRLF-records", &["-aFn", "needle", "CRLF"], None),
        (
            "invalid-UTF8-records",
            &["-aFnH", "needle", "raw-records"],
            None,
        ),
        (
            "nul-final-record",
            &["-azFn", "needle", "nul-records"],
            None,
        ),
        (
            "nul-only-matching",
            &["-azFo", "needle", "nul-records"],
            None,
        ),
        (
            "nul-invert-count",
            &["-azFvc", "needle", "nul-records"],
            None,
        ),
        ("text-binary-bytes", &["-aFn", "needle", "binary"], None),
        ("missing-first", &["-F", "needle", "missing", "hit"], None),
        ("missing-last", &["-F", "needle", "hit", "missing"], None),
        (
            "quiet-missing-first",
            &["-qF", "needle", "missing", "hit"],
            None,
        ),
        (
            "quiet-missing-last",
            &["-qF", "needle", "hit", "missing"],
            None,
        ),
        (
            "quiet-miss-error",
            &["-qF", "needle", "miss", "missing"],
            None,
        ),
        ("directory-error", &["-F", "needle", "tree"], None),
        ("stdin-explicit", &["-aFnH", "needle", "-"], None),
        ("stdin-and-file", &["-aFn", "needle", "-", "hit"], None),
        ("repeated-stdin", &["-aFn", "needle", "-", "-"], None),
        ("pattern-file-stdin", &["-aF", "-f", "-", "hit"], None),
        ("invalid-ERE", &["-E", "[", "hit"], None),
        (
            "unsupported-BRE-backref",
            &["-a", r"\(a\)\1", "overlap"],
            None,
        ),
        (
            "unsupported-context",
            &["-aF", "-B", "1", "-A", "1", "needle", "hit"],
            None,
        ),
        (
            "unicode-case-folding",
            &["-aiF", "k", "unicode"],
            Some("C.UTF-8"),
        ),
        (
            "unicode-word-boundary",
            &["-aFw", "I", "unicode"],
            Some("C.UTF-8"),
        ),
    ];
    for (id, argv, locale) in cases {
        f.compare(
            id,
            av(argv),
            Invocation {
                input: if *id == "pattern-file-stdin" {
                    b"needle\n"
                } else {
                    b"needle\nother\n"
                },
                locale: *locale,
                ..Invocation::default()
            },
        )?;
    }
    Ok(())
}
struct Random(u32);
impl Random {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }
    fn pick<'a, T>(&mut self, values: &'a [T]) -> &'a T {
        &values[self.next() as usize % values.len()]
    }
}
fn seeded_literal(f: &mut Fixture) -> Check {
    let mut random = Random(SEED);
    let literals = [
        "", "a", "aa", "alpha", "beta", "word", "_", ".", "a+b", "needle", "absent",
    ];
    let expressions = [
        "",
        "a",
        "aa",
        "^a",
        "a$",
        "a+",
        "a?",
        "a{1,3}",
        "(a|b)+",
        "[ab]",
        "[^a]",
        "[a-z]",
        "[[:digit:]]",
        "alpha|beta",
        "^.*$",
        "a.*b",
    ];
    let flags: &[&[&str]] = &[
        &[],
        &["-n"],
        &["-c"],
        &["-v"],
        &["-l"],
        &["-L"],
        &["-H"],
        &["-h"],
        &["-w"],
        &["-x"],
        &["-o"],
        &["-v", "-c"],
        &["-n", "-o"],
        &["-w", "-o"],
        &["-x", "-v"],
        &["-Z", "-l"],
    ];
    let values = [
        "a", "aa", "ab", "alpha", "beta", "word", "sword", "word_end", "a+b", "needle", "0123", "",
        "x@y", "foo\r",
    ];
    for index in 0..384 {
        let fixed = random.next() & 1 != 0;
        let nul = random.next().is_multiple_of(5);
        let selected = random.pick(flags);
        let count = 1 + random.next() % 3;
        let patterns: Vec<_> = (0..count)
            .map(|_| {
                *random.pick(if fixed {
                    literals.as_slice()
                } else {
                    expressions.as_slice()
                })
            })
            .collect();
        let records: Vec<_> = (0..random.next() % 18)
            .map(|_| {
                (0..1 + random.next() % 4)
                    .map(|_| *random.pick(&values))
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect();
        let delimiter = if nul { "\0" } else { "\n" };
        let mut data = records.join(delimiter);
        if !records.is_empty() && random.next() & 1 != 0 {
            data.push_str(delimiter);
        }
        let path = format!(".campaign-{index}");
        f.put(&path, &data)?;
        let mut argv = av(&["-a", if fixed { "-F" } else { "-E" }]);
        if nul {
            argv.push("-z".into());
        }
        argv.extend(av(selected));
        for pattern in patterns {
            argv.extend(av(&["-e", pattern]));
        }
        argv.push(path.into());
        f.compare("seeded-campaign", argv, Invocation::default())?;
    }
    if f.native == 0 {
        return Err("seeded campaign executed no native searches".into());
    }
    Ok(())
}
fn raw_traversal(f: &mut Fixture) -> Check {
    f.put(
        Path::new(OsStr::from_bytes(b"tree/raw-\xff\t\n")),
        b"needle\n",
    )?;
    f.put("tree/raw-�\t\n", b"other\n")?;
    f.put("tree/colon:name", b"needle\n")?;
    f.put("tree/-leading space", b"needle\n")?;
    for argv in [
        av(&["-arnF", "needle", "tree"]),
        av(&["-arlFZ", "needle", "tree"]),
        av(&["-arcF", "needle", "tree"]),
        av(&["-arnRF", "needle", "tree"]),
        av(&["-arlRFZ", "needle", "tree"]),
        av(&["-arnF", "needle", "tree", "tree/a.txt", "tree"]),
        av(&["-anF", "needle", "tree/linked-file"]),
    ] {
        f.compare("raw-traversal", argv, Invocation::default())?;
    }
    Ok(())
}
fn streams_and_diagnostics(f: &mut Fixture) -> Check {
    let input = b"head\nneedle needle\ntail\n";
    for argv in [
        av(&["-aFn", "needle"]),
        av(&["-aFc", "needle"]),
        av(&["-aFo", "needle"]),
        av(&["-aqF", "needle"]),
        av(&["-aFn", "needle", "-", "hit"]),
        av(&["-qF", "needle", "missing", "-"]),
    ] {
        f.compare(
            "pipe-input",
            argv,
            Invocation {
                input,
                pipe: true,
                ..Invocation::default()
            },
        )?;
    }
    for argv in [
        av(&["--unknown-grep-option"]),
        av(&["-e"]),
        av(&["-f", "missing-pattern-file", "hit"]),
        av(&["-E", "(", "hit"]),
    ] {
        f.compare("GNU-diagnostic-fallback", argv, Invocation::default())?;
    }
    f.compare(
        "seekable-stdin-cursor",
        av(&["-aFm", "1", "needle"]),
        Invocation {
            input,
            transport: Transport::Cursor,
            ..Invocation::default()
        },
    )?;
    f.put("dense-output", "needle\n".repeat(100000))?;
    f.compare(
        "closed-stdout",
        av(&["-aF", "needle", "dense-output"]),
        Invocation {
            transport: Transport::ClosedOutput,
            ..Invocation::default()
        },
    )?;
    Ok(())
}
fn parallel_order(f: &mut Fixture) -> Check {
    fs::create_dir(f.cwd.join("parallel")).map_err(|e| e.to_string())?;
    let base = "padding abcdefghijklmnopqrstuvwxyz 0123456789\n"
        .repeat(3072)
        .into_bytes();
    let mut paths = Vec::new();
    for index in 0..80 {
        let path = format!(
            "parallel/{}file-{index:03}.txt",
            if index % 4 == 0 { "." } else { "" }
        );
        let mut data = base.clone();
        if index % 3 == 0 {
            data[..6].copy_from_slice(b"needle");
        }
        f.put(&path, data)?;
        paths.push(OsString::from(path));
    }
    let mut reversed = paths.clone();
    reversed.reverse();
    reversed.push(paths[0].clone());
    let cases = [
        operands(&["-acF", "needle"], &reversed),
        av(&["-arcF", "needle", "parallel"]),
        av(&["-arcvF", "needle", "parallel"]),
        av(&["-arnF", "needle", "parallel"]),
        av(&["-arlFZ", "needle", "parallel"]),
        av(&["-arlF", "absent", "parallel"]),
        av(&["-arcE", "(needle|absent).*", "parallel"]),
    ];
    for argv in cases {
        f.parallel("parallel-release-search", argv, Transport::Direct)?;
    }
    Ok(())
}
fn boundary_files(f: &Fixture) -> Result<Vec<OsString>, String> {
    fs::create_dir(f.cwd.join("boundary-tree")).map_err(|e| e.to_string())?;
    let padding = "other abcdefghijklmnopqrstuvwxyz 0123456789\n".repeat(4096);
    let small = [0, 1, 4095, 4096, 4097];
    let mut paths = Vec::new();
    for index in 0..129 {
        let path = format!(
            "boundary-tree/{}case-{index:03}.txt",
            if index % 7 == 0 { "." } else { "" }
        );
        let data = if index == 0 {
            format!("needle {}\nother\nneedle unterminated", "x".repeat(310000)).into_bytes()
        } else if index < 6 {
            vec![b'x'; small[index - 1]]
        } else if index % 17 == 0 {
            format!("needle first-{index}\n{padding}needle last-{index}").into_bytes()
        } else {
            padding.as_bytes().to_vec()
        };
        f.put(&path, data)?;
        paths.push(path.into());
    }
    Ok(paths)
}
fn uneven_parallel(f: &mut Fixture) -> Check {
    let paths = boundary_files(f)?;
    let mut reversed = paths.clone();
    reversed.reverse();
    let mut dup_reverse = reversed.clone();
    dup_reverse.push(paths[0].clone());
    let mut dup_paths = paths.clone();
    dup_paths.push(paths[0].clone());
    for argv in [
        operands(&["-anF", "needle"], &dup_reverse),
        operands(&["-anFZ", "needle"], &dup_paths),
        operands(&["-anFh", "needle"], &reversed),
        operands(&["-anE", "(needle|absent).*"], &reversed),
        operands(&["-acF", "needle"], &dup_reverse),
        operands(&["-acvF", "needle"], &reversed),
        operands(
            &["-arnF", "needle", "boundary-tree"],
            &[paths[0].clone(), "boundary-tree".into()],
        ),
        av(&["-arlFZ", "needle", "boundary-tree"]),
    ] {
        f.parallel("parallel-variable-output-spill", argv, Transport::Direct)?;
    }
    Ok(())
}
fn late_failures(f: &mut Fixture) -> Check {
    let paths = boundary_files(f)?;
    symlink("does-not-exist", f.cwd.join("dangling-input")).map_err(|e| e.to_string())?;
    f.put("blocked-input", b"needle\n")?;
    fs::set_permissions(f.cwd.join("blocked-input"), fs::Permissions::from_mode(0o0))
        .map_err(|e| e.to_string())?;
    let misses: Vec<_> = paths
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != 0 && i % 17 != 0)
        .map(|(_, p)| p.clone())
        .collect();
    let mut missing_middle = paths[..65].to_vec();
    missing_middle.push("missing-middle".into());
    missing_middle.extend_from_slice(&paths[65..]);
    let tail = |paths: &[OsString], name: &str| {
        let mut p = paths.to_vec();
        p.push(name.into());
        p
    };
    let cases = [
        operands(
            &["-anF", "needle"],
            &tail(&paths, "missing-after-many-files"),
        ),
        operands(&["-anF", "needle"], &missing_middle),
        operands(&["-acF", "needle"], &tail(&paths, "dangling-input")),
        operands(&["-anF", "needle"], &tail(&paths, "blocked-input")),
        operands(
            &["-anFs", "needle"],
            &tail(&paths, "missing-after-many-files"),
        ),
        operands(&["-aqF", "needle"], &tail(&paths, "missing-after-match")),
        operands(&["-aqF", "needle", "missing-before-match"], &paths),
        operands(
            &["-aqF", "needle"],
            &tail(&misses, "missing-after-no-match"),
        ),
        operands(&["-anF", "needle"], &tail(&paths, "boundary-tree")),
    ];
    let result = cases.into_iter().try_for_each(|argv| {
        f.compare(
            "late-input-failure-and-quiet-order",
            argv,
            Invocation::default(),
        )
        .map(|_| ())
    });
    fs::set_permissions(
        f.cwd.join("blocked-input"),
        fs::Permissions::from_mode(0o600),
    )
    .map_err(|e| e.to_string())?;
    result
}
fn descriptor_limits(f: &mut Fixture) -> Check {
    let mut paths = boundary_files(f)?;
    let count = operands(&["-acF", "needle"], &paths);
    paths.reverse();
    for argv in [
        count,
        operands(&["-anF", "needle"], &paths),
        av(&["-arlFZ", "needle", "boundary-tree"]),
    ] {
        f.parallel(
            "bounded-input-descriptors",
            argv,
            Transport::LimitedDescriptors,
        )?;
    }
    Ok(())
}
fn dense_shortcuts(f: &mut Fixture) -> Check {
    let padding = "other ".repeat(16 * 1024);
    let mut trees = Vec::new();
    for (tree, delimiter) in [("dense-LF", "\n"), ("dense-NUL", "\0")] {
        fs::create_dir(f.cwd.join(tree)).map_err(|e| e.to_string())?;
        let mut paths = Vec::new();
        for index in 0..96 {
            let path = format!("{tree}/case-{index:03}");
            let prefix = if index < 8 {
                format!("needle{delimiter}")
            } else {
                match index % 8 {
                    0 => format!("needle{delimiter}"),
                    1 => format!("needlex{delimiter}"),
                    2 => format!("absent{delimiter}"),
                    3 => format!("{}needlex{delimiter}", " ".repeat(4090)),
                    4 => format!("needle{}suffix{delimiter}", " ".repeat(6000)),
                    5 => format!("absent{delimiter}needle{delimiter}"),
                    6 => format!("{delimiter}needle{delimiter}"),
                    _ => format!("needlex{}", "x".repeat(6000)),
                }
            };
            f.put(
                &path,
                format!(
                    "{prefix}{padding}{}",
                    if index % 8 == 7 { "" } else { delimiter }
                ),
            )?;
            paths.push(path.into());
        }
        trees.push(paths);
    }
    let lf = &trees[0];
    let nul = &trees[1];
    for argv in [
        operands(&["-alF", "needle"], lf),
        operands(&["-aLF", "needle"], lf),
        operands(&["-alwF", "needle"], lf),
        operands(&["-alxF", "needle"], lf),
        operands(&["-alE", "^needle$"], lf),
        operands(&["-aLE", "^needle$"], lf),
        operands(&["-alE", "needle$"], lf),
        operands(&["-azlF", "needle"], nul),
        operands(&["-azlFx", "needle"], nul),
    ] {
        f.parallel(
            "parallel-dense-first-record-boundaries",
            argv,
            Transport::Direct,
        )?;
    }
    Ok(())
}
fn ere_boundaries(f: &mut Fixture) -> Check {
    let crlf = b"a\r\na\n\r\n\nlast".as_slice();
    let scenarios: &[(&str, &str, &[u8], bool)] = &[
        ("dot-does-not-cross-LF", "a.*b", b"a\nb\n", false),
        (
            "negated-class-does-not-cross-LF",
            "a[^x]+b",
            b"a\nb\n",
            false,
        ),
        ("CRLF-start-end-anchors", "^a$", crlf, false),
        ("CRLF-empty-line-anchor", "^$", crlf, false),
        ("unterminated-final-anchor", "last$", crlf, false),
        (
            "empty-alternative-selects-existing-records",
            "aba|",
            b"ababa\nnone\n\ntail",
            false,
        ),
        (
            "multiple-matches-count-one-record",
            "aa",
            b"aa aa\nnone\naa",
            false,
        ),
        ("terminal-LF-has-no-phantom-record", "^$", b"a\n", false),
        ("empty-file-has-no-records", "|", b"", false),
        ("NUL-record-dot-may-cross-LF", "a.b", b"a\nb\0a\0b\0", true),
        (
            "negated-class-does-not-cross-NUL",
            "a[^x]+b",
            b"a\0b\0",
            true,
        ),
        (
            "NUL-record-anchors-ignore-payload-LF",
            "^a$",
            b"x\na\ny\0a\0a\n\0",
            true,
        ),
        ("unterminated-NUL-record-anchor", "last$", b"a\0last", true),
        ("terminal-NUL-has-no-phantom-record", "^$", b"a\0", true),
        (
            "native-alternation-counts-selected-records",
            "needle|absent",
            b"needle needle absent\nmiss\nneedle",
            false,
        ),
        (
            "native-pattern-must-not-bridge-LF",
            "(padding|needle).*012",
            b"padding aaa012\nneedle\n012\nneedle bbb012",
            false,
        ),
    ];
    let flags: &[&[&str]] = &[
        &[],
        &["-n"],
        &["-c"],
        &["-v", "-c"],
        &["-v", "-n"],
        &["-l"],
        &["-L"],
        &["-q"],
    ];
    for (index, (id, pattern, bytes, nul)) in scenarios.iter().enumerate() {
        let path = format!(".ERE-boundary-{index}");
        f.put(&path, bytes)?;
        for flag in flags {
            let mut argv = av(&["-aE"]);
            if *nul {
                argv.push("-z".into());
            }
            argv.extend(av(flag));
            argv.extend(av(&["-e", pattern, &path]));
            f.compare(
                id,
                argv,
                Invocation {
                    native: *pattern == "needle|absent" || *pattern == "(padding|needle).*012",
                    ..Invocation::default()
                },
            )?;
        }
    }
    Ok(())
}
fn seeded_ere(f: &mut Fixture) -> Check {
    let mut random = Random(ERE_SEED);
    let patterns = [
        "",
        "|",
        "^$",
        "^a$",
        "a$",
        "^a",
        "a.*b",
        "a[^x]b",
        "a[^x]+b",
        "[^x]*",
        "a[[:space:]]b",
        "(a|b)+",
        "(a|)",
        "a|aa",
        "(needle|)",
        "needle|absent",
        "(padding|needle).*012",
    ];
    let flags: &[&[&str]] = &[
        &[],
        &["-n"],
        &["-c"],
        &["-v"],
        &["-v", "-c"],
        &["-v", "-n"],
        &["-l"],
        &["-L"],
        &["-q"],
        &["-n", "-H"],
        &["-c", "-H"],
        &["-l", "-Z"],
    ];
    let payloads = [
        "",
        "a",
        "b",
        "aa",
        "ab",
        "axb",
        "ayb",
        "needle needle",
        "absent",
        "padding abc012",
        "needle012",
        "012",
        "\r",
        "a\nb",
        "needle\n012",
        "x\na\ny",
    ];
    for index in 0..768 {
        let nul = random.next().is_multiple_of(3);
        let delimiter = if nul { "\0" } else { "\n" };
        let records: Vec<_> = (0..random.next() % 20)
            .map(|_| *random.pick(&payloads))
            .collect();
        let mut text = records.join(delimiter);
        if !records.is_empty() && !random.next().is_multiple_of(2) {
            text.push_str(delimiter);
        }
        let mut bytes = text.into_bytes();
        if random.next().is_multiple_of(7) {
            bytes.insert(0, 0xff);
        }
        let names = [
            format!(".ERE-seeded-{index}-a"),
            format!(".ERE-seeded-{index}-b"),
        ];
        f.put(&names[0], &bytes)?;
        bytes.reverse();
        f.put(&names[1], bytes)?;
        let flags = random.pick(flags);
        let selected: Vec<_> = (0..1 + random.next() % 3)
            .map(|_| *random.pick(&patterns))
            .collect();
        let mut argv = av(&["-aE"]);
        if nul {
            argv.push("-z".into());
        }
        argv.extend(av(flags));
        for pattern in selected {
            argv.extend(av(&["-e", pattern]));
        }
        argv.extend(names.map(OsString::from));
        f.compare("seeded-ERE-boundaries", argv, Invocation::default())?;
    }
    if f.native == 0 {
        return Err("ERE campaign executed no native searches".into());
    }
    Ok(())
}

fn main() {
    let binary = env::var_os("GREP2RG_RUST_BINARY")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/release/grep2rg-rust")
        });
    let binary = fs::canonicalize(binary)
        .expect("build the real release executable before GNU qualification");
    let initial_hash = hash(&binary).expect("hash the production artifact");
    let self_checks =
        runner_self_checks().expect("oracle runner negative controls and fault checks");
    let report_path = env::var_os("GREP2RG_ORACLE_RESULT_JSON").map(PathBuf::from);
    let groups: [Group; 12] = [
        ("28 measured classes", measured_classes),
        (
            "option interactions and input boundaries",
            option_boundaries,
        ),
        ("seeded literal and safe ERE", seeded_literal),
        ("raw traversal ordering", raw_traversal),
        ("pipes cursors and diagnostics", streams_and_diagnostics),
        ("parallel output ordering", parallel_order),
        ("uneven parallel output spill", uneven_parallel),
        ("late failure and quiet error order", late_failures),
        ("bounded parallel descriptors", descriptor_limits),
        ("dense first-record shortcuts", dense_shortcuts),
        ("whole-buffer ERE boundaries", ere_boundaries),
        ("seeded ERE boundaries", seeded_ere),
    ];
    println!("TAP version 13\n1..{}", groups.len());
    let mut total = 0;
    let mut native = 0;
    let mut fallback = 0;
    let mut failures = 0;
    let mut classes = BTreeMap::<String, usize>::new();
    let mut outcomes = Vec::new();
    let mut case_ids = Vec::new();
    for (index, (name, run)) in groups.iter().enumerate() {
        let mut fixture = Fixture::new(&binary, if index == 11 { ERE_SEED } else { SEED })
            .expect("owned fixture initialization");
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&mut fixture)))
            .unwrap_or_else(|_| Err("oracle group panicked".into()))
            .and_then(|()| fixture.unchanged())
            .and_then(|()| {
                if fixture.artifact_hash == initial_hash {
                    Ok(())
                } else {
                    Err("release binary changed between qualification groups".into())
                }
            });
        fixture.passed = result.is_ok();
        if let Err(error) = &result {
            failures += 1;
            fixture.failures.push(json!({"group":name,"error":error}));
            println!(
                "not ok {} - {name}\n# failure: {}",
                index + 1,
                error.replace('\n', "\n# ")
            );
        } else {
            println!("ok {} - {name}", index + 1);
        }
        total += fixture.comparisons;
        native += fixture.native;
        fallback += fixture.fallback;
        for (name, count) in &fixture.classes {
            *classes.entry(name.clone()).or_default() += count;
        }
        case_ids.extend(
            fixture
                .case_ids
                .iter()
                .map(|id| format!("group-{}/{id}", index + 1)),
        );
        outcomes.push(json!({"id":format!("group-{}",index+1),"name":name,"passed":fixture.passed,"comparisons":fixture.comparisons}));
    }
    if failures == 0 && total != 1411 {
        eprintln!("case inventory changed: expected 1411 comparisons, received {total}");
        failures += 1;
    }
    let aggregate = json!({"schemaVersion":2,"runner":"rust/tests/gnu_oracle.rs","status":if failures==0{"passed"}else{"failed"},"artifactSHA256":initial_hash,"comparisons":total,"rustSearches":native,"gnuFallbacks":fallback,"ioComparisons":0,"classes":classes,"caseIds":case_ids,"groups":outcomes,"failures":failures,"tests":12,"passedGroups":12-failures.min(12),"runnerSelfChecks":self_checks});
    if let Some(path) = report_path {
        fs::write(path, serde_json::to_vec_pretty(&aggregate).unwrap())
            .expect("write aggregate oracle evidence");
    }
    println!("GREP2RG_ENGINE_REPORT={aggregate}");
    println!("# tests 12\n# suites 0\n# pass {}\n# fail {failures}\n# cancelled 0\n# skipped 0\n# todo 0",12-failures.min(12));
    std::process::exit(if failures == 0 { 0 } else { 1 });
}
