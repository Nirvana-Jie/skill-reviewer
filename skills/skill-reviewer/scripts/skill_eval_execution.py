#!/usr/bin/env python3
"""Shared locked-execution rules for local Skill Eval provider adapters.

The module is the internal seam between provider-specific event adapters and
the provider-neutral Runtime.  It owns immutable assignment validation,
explicit child-process environment construction, credential redaction, and
process-group cleanup.  It never interprets provider event formats.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

from skill_eval_authority import (
    load_json,
    safe_artifact,
    sha256_file,
    trace_assignment_context,
)
from skill_eval_contracts import ManifestError


ENV_NAME_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
SECRET_ENV_NAME_PATTERN = re.compile(
    r"(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|"
    r"PRIVATE_KEY|ACCESS_KEY|AUTH_TOKEN)(?:_|$)"
)
SAFE_PROVIDER_ENV_NAMES = frozenset(
    {
        "APPDATA",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "COLORTERM",
        "COMSPEC",
        "HOME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "LOCALAPPDATA",
        "LOGNAME",
        "NODE_EXTRA_CA_CERTS",
        "NO_COLOR",
        "PATH",
        "PATHEXT",
        "SHELL",
        "SSL_CERT_DIR",
        "SSL_CERT_FILE",
        "SYSTEMROOT",
        "TEMP",
        "TERM",
        "TMP",
        "TMPDIR",
        "USER",
        "USERPROFILE",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
    }
)
FORBIDDEN_DETAIL_KEYS = frozenset(
    {
        "analysis",
        "chain_of_thought",
        "encrypted_content",
        "encrypted_reasoning",
        "private_reasoning",
        "reasoning",
        "signature",
        "thinking",
        "thought",
        "thoughts",
    }
)
MAX_TRACE_STRING = 24_000
MAX_TRACE_LIST = 100
REDACTED_CREDENTIAL = "[REDACTED_CREDENTIAL]"
REDACTION_SENTINEL = "\x00SKILL_REVIEWER_CREDENTIAL\x00"
MIN_CREDENTIAL_BYTES = 8


@dataclass(frozen=True)
class ProviderSpec:
    """Facts that genuinely vary between provider adapters."""

    label: str
    target: str
    harness: str
    source_artifact: str
    source_format: str
    stderr_artifact: str
    required_capabilities: tuple[str, ...]
    full_access_capability: str | None = None


@dataclass(frozen=True)
class LockedAssignment:
    assignment: dict[str, Any]
    repeat_root: Path
    trace_path: Path
    profile: dict[str, Any]


@dataclass(frozen=True)
class ProviderEnvironment:
    values: dict[str, str]
    credential_values: tuple[str, ...]
    passed_name_count: int
    credential_name_count: int
    declared_names_digest: str


@dataclass(frozen=True)
class ProviderProcessResult:
    return_code: int
    timed_out: bool
    stderr_text: str
    stderr_line_count: int
    stderr_credential_observation_count: int


@dataclass(frozen=True)
class ProviderCaptureResult:
    source_digest: str
    stderr_digest: str | None
    retained_source_stream_digest: str
    retained_event_count: int
    credential_leak_paths: tuple[str, ...]
    credential_leak_count: int


@dataclass(frozen=True)
class ProviderSourceError:
    kind: str
    source_event_index: int
    source_sha256: str
    source_bytes: int


@dataclass(frozen=True)
class ProviderStreamResult:
    source_event_count: int
    parse_error_count: int
    credential_observation_count: int
    source_stream_digest: str


def compact_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _validated_env_names(raw_names: Sequence[str], label: str) -> list[str]:
    result: list[str] = []
    for raw_name in raw_names:
        name = str(raw_name).strip()
        if not ENV_NAME_PATTERN.fullmatch(name):
            raise ManifestError(f"{label} contains an invalid environment name")
        if name not in result:
            result.append(name)
    return result


def build_provider_environment(
    *,
    pass_env: Sequence[str] = (),
    credential_env: Sequence[str] = (),
    source: Mapping[str, str] | None = None,
) -> ProviderEnvironment:
    """Build a minimal child environment plus explicitly authorized values."""

    host = os.environ if source is None else source
    passed_names = _validated_env_names(pass_env, "--pass-env")
    credential_names = _validated_env_names(
        credential_env, "--credential-env"
    )
    overlap = sorted(set(passed_names) & set(credential_names))
    if overlap:
        raise ManifestError(
            "environment names cannot be both ordinary and credential values: "
            + ", ".join(overlap)
        )
    secret_like_passed_names = [
        name for name in passed_names if SECRET_ENV_NAME_PATTERN.search(name.upper())
    ]
    if secret_like_passed_names:
        raise ManifestError(
            "secret-like environment names require --credential-env: "
            + ", ".join(secret_like_passed_names)
        )
    requested = [*passed_names, *credential_names]
    missing = [name for name in requested if name not in host]
    if missing:
        raise ManifestError(
            "requested provider environment values are unavailable: "
            + ", ".join(missing)
        )
    values = {
        name: str(host[name])
        for name in sorted(SAFE_PROVIDER_ENV_NAMES)
        if name in host
    }
    for name in requested:
        values[name] = str(host[name])
    values["NO_COLOR"] = "1"
    credential_records = {
        name: str(host[name])
        for name in credential_names
    }
    invalid_credentials = [
        name
        for name, value in credential_records.items()
        if not value.strip()
        or len(value.encode("utf-8")) < MIN_CREDENTIAL_BYTES
        or value == REDACTED_CREDENTIAL
        or REDACTION_SENTINEL in value
    ]
    if invalid_credentials:
        raise ManifestError(
            "declared provider credentials must be non-blank, at least "
            f"{MIN_CREDENTIAL_BYTES} UTF-8 bytes, and distinct from redaction markers: "
            + ", ".join(invalid_credentials)
        )
    credentials = tuple(
        sorted(
            set(credential_records.values()),
            key=len,
            reverse=True,
        )
    )
    return ProviderEnvironment(
        values=values,
        credential_values=credentials,
        passed_name_count=len(passed_names),
        credential_name_count=len(credential_names),
        declared_names_digest=sha256_text("\n".join(sorted(requested))),
    )


def _credential_text_variants(credential_values: Sequence[str]) -> tuple[str, ...]:
    variants: set[str] = set()
    for secret in credential_values:
        if not secret:
            continue
        variants.add(secret)
        variants.add(json.dumps(secret, ensure_ascii=True)[1:-1])
        variants.add(json.dumps(secret, ensure_ascii=False)[1:-1])
    return tuple(sorted((value for value in variants if value), key=len, reverse=True))


def redact_text(value: str, credential_values: Sequence[str]) -> str:
    sentinel = REDACTION_SENTINEL
    while sentinel in value:
        sentinel += "_"
    redacted = value
    for secret in _credential_text_variants(credential_values):
        redacted = redacted.replace(secret, sentinel)
    return redacted.replace(sentinel, REDACTED_CREDENTIAL)


def contains_credential(value: Any, credential_values: Sequence[str]) -> bool:
    """Detect an exact credential in parsed observable data without serializing it."""

    variants = _credential_text_variants(credential_values)
    pending = [value]
    while pending:
        current = pending.pop()
        if isinstance(current, str):
            if any(secret in current for secret in variants):
                return True
        elif isinstance(current, dict):
            pending.extend(current.keys())
            pending.extend(current.values())
        elif isinstance(current, (list, tuple)):
            pending.extend(current)
    return False


def sanitize_observable(
    value: Any,
    *,
    credential_values: Sequence[str] = (),
    depth: int = 0,
) -> Any:
    """Bound an observable payload and remove private or credential content."""

    if depth > 8:
        return "<nested payload omitted>"
    if isinstance(value, dict):
        if value.get("type") in {"thinking", "reasoning"}:
            return {
                "id": value.get("id"),
                "type": value.get("type"),
                "redacted": True,
            }
        result: dict[str, Any] = {}
        for key, item in value.items():
            if (
                str(key).strip().lower().replace("-", "_")
                in FORBIDDEN_DETAIL_KEYS
            ):
                continue
            result[redact_text(str(key), credential_values)] = sanitize_observable(
                item,
                credential_values=credential_values,
                depth=depth + 1,
            )
        return result
    if isinstance(value, list):
        result = [
            sanitize_observable(
                item,
                credential_values=credential_values,
                depth=depth + 1,
            )
            for item in value[:MAX_TRACE_LIST]
        ]
        if len(value) > MAX_TRACE_LIST:
            result.append(f"<{len(value) - MAX_TRACE_LIST} items omitted>")
        return result
    if isinstance(value, str):
        bounded = (
            value[:MAX_TRACE_STRING]
            + f"\n<{len(value) - MAX_TRACE_STRING} characters omitted>"
            if len(value) > MAX_TRACE_STRING
            else value
        )
        return redact_text(bounded, credential_values)
    if value is None or isinstance(value, (int, float, bool)):
        return value
    return redact_text(str(value), credential_values)


def capture_provider_jsonl(
    *,
    source: Iterable[str],
    destination: Path,
    credential_values: Sequence[str],
    on_event: Callable[[dict[str, Any], int], None],
    on_error: Callable[[ProviderSourceError], None] | None = None,
) -> ProviderStreamResult:
    """Retain one bounded JSONL stream and expose only sanitized object events."""

    source_event_count = 0
    parse_error_count = 0
    credential_observation_count = 0
    source_stream_hasher = hashlib.sha256()
    with destination.open("w", encoding="utf-8") as destination_handle:
        for line in source:
            source_event_count += 1
            encoded = line.encode("utf-8")
            source_stream_hasher.update(encoded)
            stripped = line.strip()
            if not stripped:
                continue
            line_contains_credential = (
                redact_text(stripped, credential_values) != stripped
            )
            try:
                raw_event = json.loads(stripped)
            except json.JSONDecodeError:
                raw_event = None
                error_kind = "unparseable"
            else:
                error_kind = "invalid"
                if not line_contains_credential and contains_credential(
                    raw_event, credential_values
                ):
                    line_contains_credential = True
                raw_event = sanitize_observable(
                    raw_event,
                    credential_values=credential_values,
                )
            if line_contains_credential:
                credential_observation_count += 1
            if not isinstance(raw_event, dict):
                parse_error_count += 1
                error = ProviderSourceError(
                    kind=error_kind,
                    source_event_index=source_event_count,
                    source_sha256=sha256_text(stripped),
                    source_bytes=len(encoded),
                )
                destination_handle.write(
                    compact_json(
                        {
                            "type": error.kind,
                            "source_event_index": error.source_event_index,
                            "source_sha256": error.source_sha256,
                            "source_bytes": error.source_bytes,
                        }
                    )
                    + "\n"
                )
                destination_handle.flush()
                if on_error is not None:
                    on_error(error)
                continue
            destination_handle.write(compact_json(raw_event) + "\n")
            destination_handle.flush()
            on_event(raw_event, source_event_count)
    return ProviderStreamResult(
        source_event_count=source_event_count,
        parse_error_count=parse_error_count,
        credential_observation_count=credential_observation_count,
        source_stream_digest=source_stream_hasher.hexdigest(),
    )


def redact_retained_credentials(
    *,
    root: Path,
    relative_paths: Sequence[str],
    credential_values: Sequence[str],
) -> list[str]:
    """Atomically redact exact credential values from retained regular files."""

    if not credential_values:
        return []
    secret_bytes = [
        value.encode("utf-8")
        for value in _credential_text_variants(credential_values)
    ]
    leaks: list[str] = []
    for relative in dict.fromkeys(str(path) for path in relative_paths):
        path = safe_artifact(root, relative)
        if not path.exists():
            continue
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ManifestError(
                f"credential scan requires a private regular artifact: {relative}"
            )
        raw = path.read_bytes()
        sentinel = REDACTION_SENTINEL.encode("utf-8")
        while sentinel in raw:
            sentinel += b"_"
        redacted = raw
        for secret in secret_bytes:
            redacted = redacted.replace(secret, sentinel)
        redacted = redacted.replace(
            sentinel,
            REDACTED_CREDENTIAL.encode("utf-8"),
        )
        if redacted == raw:
            continue
        leaks.append(relative)
        descriptor, temporary = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".redacted", dir=path.parent
        )
        temporary_path = Path(temporary)
        try:
            os.fchmod(descriptor, stat.S_IMODE(metadata.st_mode))
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(redacted)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, path)
        finally:
            temporary_path.unlink(missing_ok=True)
    return leaks


def run_provider_process(
    *,
    command: Sequence[str],
    cwd: Path,
    environment: ProviderEnvironment,
    timeout_seconds: int,
    assignment: Mapping[str, Any],
    on_started: Callable[[int, str], None],
    consume_stdout: Callable[[Any], None],
) -> ProviderProcessResult:
    """Run one provider with shared dispatch identity, redaction, and cleanup."""

    stderr_credential_observation_count = 0

    def redact_stderr_line(line: str) -> str:
        nonlocal stderr_credential_observation_count
        redacted = redact_text(line, environment.credential_values)
        if redacted != line:
            stderr_credential_observation_count += 1
        return redacted

    with ManagedProviderProcess(
        command=command,
        cwd=cwd,
        environment=environment.values,
        timeout_seconds=timeout_seconds,
        redact_stderr=redact_stderr_line,
    ) as process:
        dispatch_seed = "|".join(
            [
                str(assignment.get("run_id")),
                str(assignment.get("case_id")),
                str(assignment.get("arm")),
                str(assignment.get("repeat")),
                str(process.pid),
                str(time.time_ns()),
            ]
        )
        on_started(process.pid, f"dispatch-{sha256_text(dispatch_seed)[:20]}")
        consume_stdout(process.stdout)
        return_code = process.wait()
        return ProviderProcessResult(
            return_code=return_code,
            timed_out=process.timed_out,
            stderr_text=process.stderr_text,
            stderr_line_count=process.stderr_line_count,
            stderr_credential_observation_count=(
                stderr_credential_observation_count
            ),
        )


def finalize_provider_capture(
    *,
    root: Path,
    source_path: Path,
    stderr_path: Path,
    trace_path: Path,
    retained_paths: Sequence[str],
    environment: ProviderEnvironment,
    process: ProviderProcessResult,
    source_stream_digest: str,
    credential_observation_count: int,
) -> ProviderCaptureResult:
    """Redact retained files and derive one provider-neutral capture result."""

    if process.stderr_text:
        stderr_path.write_text(process.stderr_text, encoding="utf-8")
    relative_paths = [
        source_path.relative_to(root).as_posix(),
        stderr_path.relative_to(root).as_posix(),
        trace_path.relative_to(root).as_posix(),
        *retained_paths,
    ]
    credential_leak_paths = tuple(
        redact_retained_credentials(
            root=root,
            relative_paths=relative_paths,
            credential_values=environment.credential_values,
        )
    )
    source_digest = sha256_file(source_path)
    stderr_digest = sha256_file(stderr_path) if stderr_path.is_file() else None
    retained_source_stream_digest = (
        source_digest if credential_observation_count else source_stream_digest
    )
    retained_event_count = sum(
        1
        for line in source_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    )
    return ProviderCaptureResult(
        source_digest=source_digest,
        stderr_digest=stderr_digest,
        retained_source_stream_digest=retained_source_stream_digest,
        retained_event_count=retained_event_count,
        credential_leak_paths=credential_leak_paths,
        credential_leak_count=(
            credential_observation_count
            + process.stderr_credential_observation_count
            + len(credential_leak_paths)
        ),
    )


def load_locked_assignment(
    *,
    assignment_path: Path,
    workspace: Path,
    provider: ProviderSpec,
    verify_plan: Callable[..., dict[str, Any]],
    full_access: bool = False,
) -> LockedAssignment:
    """Validate one immutable assignment against its plan and provider profile."""

    workspace = workspace.resolve()
    assignment_path = assignment_path.resolve()
    assignment, repeat_root, trace_path = trace_assignment_context(
        assignment_path=assignment_path,
        workspace=workspace,
    )
    plan_path = workspace / "execution-plan.json"
    lock_path = workspace / "run-lock.json"
    if not plan_path.is_file() or not lock_path.is_file():
        raise ManifestError(
            f"{provider.label} executor requires execution-plan.json and run-lock.json"
        )
    plan = load_json(plan_path)
    lock = load_json(lock_path)
    # A digest recorded in a mutable lock file is not an authority by itself.
    # Reconstruct the complete plan, assignments, snapshots, fixtures, and lock
    # from their pinned sources before any provider-visible work begins.
    verify_plan(plan_path=plan_path, workspace=workspace, plan=plan)
    relative_assignment = assignment_path.relative_to(workspace).as_posix()
    assignment_digests = lock.get("assignment_digests")
    if (
        not isinstance(assignment_digests, dict)
        or assignment_digests.get(relative_assignment)
        != sha256_file(assignment_path)
    ):
        raise ManifestError("assignment digest does not match the immutable run lock")
    if lock.get("plan_digest") != sha256_file(plan_path):
        raise ManifestError(
            "execution plan digest does not match the immutable run lock"
        )
    if (
        plan.get("run_id") != assignment.get("run_id")
        or lock.get("run_id") != assignment.get("run_id")
    ):
        raise ManifestError(
            "assignment, plan, and run lock identities do not match"
        )
    profile = plan.get("execution_profile")
    if not isinstance(profile, dict):
        raise ManifestError("execution plan is missing its execution profile")
    if profile.get("digest") != assignment.get("execution_profile_digest"):
        raise ManifestError("assignment execution profile digest is stale")
    if (
        profile.get("target") != provider.target
        or profile.get("harness") != provider.harness
    ):
        raise ManifestError(
            f"{provider.label} executor requires target={provider.target} "
            f"and harness={provider.harness}"
        )
    if profile.get("dispatch_observation") != "process_spawn":
        raise ManifestError(
            f"{provider.label} execution profile must declare "
            "dispatch_observation=process_spawn"
        )
    if profile.get("isolation") != "local-unattested":
        raise ManifestError(
            f"local {provider.label} execution must be declared as "
            "isolation=local-unattested"
        )
    trace_profile = profile.get("trace")
    if (
        not isinstance(trace_profile, dict)
        or trace_profile.get("capture_source") != "provider_stream"
        or trace_profile.get("source")
        != {
            "artifact": provider.source_artifact,
            "format": provider.source_format,
        }
    ):
        raise ManifestError(
            f"{provider.label} execution profile must bind the "
            "provider-stream source adapter"
        )
    capabilities = profile.get("capabilities")
    if not isinstance(capabilities, list):
        raise ManifestError(
            f"{provider.label} execution profile capabilities are invalid"
        )
    missing_capabilities = [
        item for item in provider.required_capabilities if item not in capabilities
    ]
    if missing_capabilities:
        raise ManifestError(
            f"{provider.label} execution profile must declare "
            + ", ".join(missing_capabilities)
        )
    if (
        full_access
        and provider.full_access_capability
        and provider.full_access_capability not in capabilities
    ):
        raise ManifestError(
            f"--full-access requires {provider.full_access_capability} "
            "in the locked execution profile"
        )
    execution_artifact = assignment.get("execution_artifact")
    if not isinstance(execution_artifact, str):
        raise ManifestError("assignment.execution_artifact is invalid")
    dispatch_artifact = assignment.get("dispatch_artifact")
    if not isinstance(dispatch_artifact, str):
        raise ManifestError("assignment.dispatch_artifact is invalid")
    generated = [
        trace_path,
        safe_artifact(repeat_root, execution_artifact),
        safe_artifact(repeat_root, dispatch_artifact),
        repeat_root / provider.source_artifact,
        repeat_root / provider.stderr_artifact,
    ]
    for path in generated:
        if path.exists() or path.is_symlink():
            raise ManifestError(f"executor output already exists: {path.name}")
    expected = assignment.get("expected_artifacts")
    if not isinstance(expected, list) or not all(
        isinstance(value, str) for value in expected
    ):
        raise ManifestError("assignment.expected_artifacts must be a string array")
    for relative in expected:
        artifact = safe_artifact(repeat_root, relative)
        if artifact.exists() or artifact.is_symlink():
            raise ManifestError(
                f"expected artifact already exists before execution: {relative}"
            )
        artifact.parent.mkdir(parents=True, exist_ok=True)
    return LockedAssignment(
        assignment=assignment,
        repeat_root=repeat_root,
        trace_path=trace_path,
        profile=profile,
    )


def terminate_process_group(
    process: subprocess.Popen[str], *, grace_seconds: float = 2.0
) -> None:
    """Terminate the whole provider process group and reap the child."""

    if process.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
    except (OSError, ProcessLookupError):
        process.poll()
        return
    try:
        process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except (OSError, ProcessLookupError):
            process.poll()
            return
        process.wait()


class ManagedProviderProcess:
    """Stream one provider process with timeout and guaranteed group cleanup."""

    def __init__(
        self,
        *,
        command: Sequence[str],
        cwd: Path,
        environment: Mapping[str, str],
        timeout_seconds: int,
        redact_stderr: Callable[[str], str] | None = None,
    ) -> None:
        self._command = list(command)
        self._cwd = cwd
        self._environment = dict(environment)
        self._timeout_seconds = timeout_seconds
        self._redact_stderr = redact_stderr or (lambda value: value)
        self._process: subprocess.Popen[str] | None = None
        self._stderr_thread: threading.Thread | None = None
        self._timer: threading.Timer | None = None
        self._timed_out = threading.Event()
        self._stderr_lines: list[str] = []

    def __enter__(self) -> "ManagedProviderProcess":
        self._process = subprocess.Popen(
            self._command,
            cwd=self._cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=1,
            env=self._environment,
            start_new_session=(os.name == "posix"),
        )

        def read_stderr() -> None:
            assert self._process is not None and self._process.stderr is not None
            for line in self._process.stderr:
                self._stderr_lines.append(self._redact_stderr(line))

        try:
            stderr_thread = threading.Thread(target=read_stderr, daemon=True)
            stderr_thread.start()
            self._stderr_thread = stderr_thread
            self._timer = threading.Timer(self._timeout_seconds, self._on_timeout)
            self._timer.daemon = True
            self._timer.start()
        except BaseException:
            terminate_process_group(self._process)
            self._finish_background_work()
            raise
        return self

    def _on_timeout(self) -> None:
        self._timed_out.set()
        if self._process is not None:
            terminate_process_group(self._process)

    @property
    def pid(self) -> int:
        if self._process is None:
            raise ManifestError("provider process has not started")
        return self._process.pid

    @property
    def stdout(self) -> Any:
        if self._process is None or self._process.stdout is None:
            raise ManifestError("provider stdout is unavailable")
        return self._process.stdout

    @property
    def timed_out(self) -> bool:
        return self._timed_out.is_set()

    @property
    def stderr_text(self) -> str:
        return "".join(self._stderr_lines)

    @property
    def stderr_line_count(self) -> int:
        return len(self._stderr_lines)

    def wait(self) -> int:
        if self._process is None:
            raise ManifestError("provider process has not started")
        return_code = self._process.wait()
        self._finish_background_work()
        return return_code

    def _finish_background_work(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
        if self._stderr_thread is not None:
            self._stderr_thread.join(timeout=5)

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        if self._process is not None and self._process.poll() is None:
            terminate_process_group(self._process)
        self._finish_background_work()
