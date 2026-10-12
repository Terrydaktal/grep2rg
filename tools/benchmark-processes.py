#!/usr/bin/env python3
"""Time direct CLI processes from a JSON batch without timing this interpreter.

Read {"jobs": [...]} from stdin and emit {"observations": [...]} to stdout.
Each job's argv includes argv[0]; program names the actual executable. The env
mapping replaces the environment rather than inheriting this driver's values.
Timing includes Popen, complete child execution and pipe capture, and excludes
manifest parsing, base64 decoding, result encoding and JSON serialization.
"""

import base64
import binascii
import errno
import json
import math
import os
import selectors
import signal
import subprocess
import sys
import time


CHANNEL_LIMIT = 32 * 1024 * 1024
READ_CHUNK = 64 * 1024
KILL_DRAIN_SECONDS = 1.0
LABEL_FIELDS = ("id", "round", "warmup", "label")


def failure(code, message):
    return {"code": code, "message": message}


def validate_job(job):
    if not isinstance(job, dict):
        raise ValueError("Each job must be a JSON object")
    program = job.get("program")
    argv = job.get("argv")
    if not isinstance(program, str) or not program or "\0" in program:
        raise ValueError("program must be a nonempty executable path")
    if not isinstance(argv, list) or not argv:
        raise ValueError("argv must include argv[0]")
    if any(not isinstance(value, str) or "\0" in value for value in argv):
        raise ValueError("argv values must be strings without NUL bytes")
    env = job.get("env", {})
    if not isinstance(env, dict) or any(
        not isinstance(key, str)
        or not key
        or "=" in key
        or "\0" in key
        or not isinstance(value, str)
        or "\0" in value
        for key, value in env.items()
    ):
        raise ValueError("env must map valid environment names to strings")
    cwd = job.get("cwd")
    if cwd is not None and (not isinstance(cwd, str) or "\0" in cwd):
        raise ValueError("cwd must be a path string or null")
    timeout_ms = job.get("timeoutMs", 120_000)
    if (
        isinstance(timeout_ms, bool)
        or not isinstance(timeout_ms, (int, float))
        or not math.isfinite(timeout_ms)
        or timeout_ms <= 0
    ):
        raise ValueError("timeoutMs must be a finite positive number")
    limit = job.get("maxCapturedBytesPerChannel", CHANNEL_LIMIT)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 0 < limit <= CHANNEL_LIMIT:
        raise ValueError("maxCapturedBytesPerChannel must be 1..33554432")
    encoded = job.get("stdinBase64", "")
    if not isinstance(encoded, str):
        raise ValueError("stdinBase64 must be a base64 string")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("stdinBase64 must contain valid base64") from exc
    return program, argv, env, cwd, timeout_ms / 1000, limit, data


def kill_owned_group(process):
    # start_new_session=True gives this child its own process group. Descendants
    # retaining output pipes belong to that same owned group unless they detach.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def close_registered(selector, stream):
    try:
        selector.unregister(stream)
    except KeyError:
        pass
    stream.close()


def run_job(job):
    observation = {key: job.get(key) for key in LABEL_FIELDS} if isinstance(job, dict) else {}
    observation.update(
        durationMs=0.0,
        status=None,
        signal=None,
        error=None,
        stdoutBase64="",
        stderrBase64="",
    )
    try:
        program, argv, env, cwd, timeout, limit, data = validate_job(job)
    except ValueError as exc:
        observation["error"] = failure("INVALID_JOB", str(exc))
        return observation
    if sys.platform != "linux" or not hasattr(os, "pidfd_open"):
        observation["error"] = failure("TIMING_UNAVAILABLE", "Linux pidfd support is required")
        return observation

    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    selector = selectors.DefaultSelector()
    process = None
    process_fd = None
    phase = "spawn"
    offset = 0
    deadline = None
    drain_deadline = None
    start = time.perf_counter_ns()
    try:
        process = subprocess.Popen(
            argv,
            executable=program,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            env=env,
            start_new_session=True,
            bufsize=0,
        )
        phase = "pidfd"
        process_fd = os.fdopen(os.pidfd_open(process.pid), "rb", buffering=0)
        selector.register(process_fd, selectors.EVENT_READ, "process")
        phase = "capture"
        deadline = start / 1_000_000_000 + timeout
        for name, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        if data:
            os.set_blocking(process.stdin.fileno(), False)
            selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
        else:
            process.stdin.close()

        while selector.get_map():
            now = time.perf_counter()
            if drain_deadline is None and now >= deadline:
                observation["error"] = failure("TIMEOUT", "Child exceeded timeoutMs")
                kill_owned_group(process)
                drain_deadline = now + KILL_DRAIN_SECONDS
                if not process.stdin.closed:
                    close_registered(selector, process.stdin)
            if drain_deadline is not None and now >= drain_deadline:
                for key in list(selector.get_map().values()):
                    close_registered(selector, key.fileobj)
                break
            remaining = (drain_deadline if drain_deadline is not None else deadline) - now
            for key, _events in selector.select(max(0, remaining)):
                stream = key.fileobj
                if stream.closed:
                    continue
                if key.data == "process":
                    # pidfd readability means the direct child exited. Reap it
                    # immediately; wait(timeout=...) would use Python's polling
                    # sleeps and could add a whole millisecond to tiny searches.
                    process.wait()
                    close_registered(selector, stream)
                    if not process.stdin.closed:
                        close_registered(selector, process.stdin)
                    continue
                if key.data == "stdin":
                    try:
                        offset += os.write(stream.fileno(), memoryview(data)[offset : offset + READ_CHUNK])
                    except BrokenPipeError:
                        close_registered(selector, stream)
                        continue
                    except BlockingIOError:
                        continue
                    if offset >= len(data):
                        close_registered(selector, stream)
                    continue
                try:
                    chunk = os.read(stream.fileno(), READ_CHUNK)
                except BlockingIOError:
                    continue
                if not chunk:
                    close_registered(selector, stream)
                    continue
                retained = buffers[key.data]
                available = limit - len(retained)
                retained.extend(chunk[:available])
                if len(chunk) > available and observation["error"] is None:
                    observation["error"] = failure(
                        "OUTPUT_LIMIT", f"Child exceeded {limit} captured bytes on {key.data}"
                    )
                    kill_owned_group(process)
                    drain_deadline = time.perf_counter() + KILL_DRAIN_SECONDS
                    if not process.stdin.closed:
                        close_registered(selector, process.stdin)

        if process.returncode is None and process.poll() is None:
            observation["error"] = failure("REAP_TIMEOUT", "Killed child was not reaped")
        if process.returncode is not None:
            observation["status"] = process.returncode if process.returncode >= 0 else None
            observation["signal"] = -process.returncode if process.returncode < 0 else None
    except OSError as exc:
        observation["error"] = failure(
            "SPAWN_ERROR" if phase == "spawn" else "TIMING_UNAVAILABLE" if phase == "pidfd" else "CAPTURE_ERROR",
            f"{errno.errorcode.get(exc.errno, 'OS_ERROR')}: {exc.strerror}",
        )
    except Exception as exc:  # Preserve structured evidence instead of losing the rest of a batch.
        observation["error"] = failure("DRIVER_ERROR", f"{type(exc).__name__}: {exc}")
    finally:
        if process is not None and process.poll() is None:
            kill_owned_group(process)
            # Exceptional cleanup only: healthy timings have already received
            # the pidfd event and reaped immediately above. Do not add polling
            # sleeps to any successful timed observation.
            if process_fd is not None and not process_fd.closed:
                cleanup = selectors.DefaultSelector()
                try:
                    cleanup.register(process_fd, selectors.EVENT_READ)
                    if cleanup.select(KILL_DRAIN_SECONDS):
                        process.wait()
                    else:
                        observation["error"] = failure("REAP_TIMEOUT", "Killed child was not reaped")
                finally:
                    cleanup.close()
            elif process.poll() is None:
                observation["error"] = failure("REAP_TIMEOUT", "No pidfd available to reap killed child")
        observation["durationMs"] = (time.perf_counter_ns() - start) / 1_000_000
        for key in list(selector.get_map().values()):
            close_registered(selector, key.fileobj)
        selector.close()
        if process_fd is not None and not process_fd.closed:
            process_fd.close()
        if process is not None:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None and not stream.closed:
                    stream.close()
    observation["stdoutBase64"] = base64.b64encode(buffers["stdout"]).decode("ascii")
    observation["stderrBase64"] = base64.b64encode(buffers["stderr"]).decode("ascii")
    return observation


def main():
    try:
        manifest = json.load(sys.stdin)
        if not isinstance(manifest, dict) or not isinstance(manifest.get("jobs"), list):
            raise ValueError("Expected a JSON object containing a jobs array")
        if len(manifest["jobs"]) > 10_000:
            raise ValueError("A batch may contain at most 10000 jobs")
    except (ValueError, json.JSONDecodeError) as exc:
        json.dump({"observations": [], "error": failure("INVALID_MANIFEST", str(exc))}, sys.stdout)
        sys.stdout.write("\n")
        return 2
    observations = [run_job(job) for job in manifest["jobs"]]
    json.dump({"observations": observations}, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
