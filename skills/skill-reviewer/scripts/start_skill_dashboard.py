#!/usr/bin/env python3
"""Project one Skill Reviewer run and start its temporary local control plane."""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import secrets
import signal
import sys
import webbrowser
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Event, Thread
from urllib.parse import urlencode

from dashboard_bundle import (
    DashboardBundleError,
    MaterializedDashboardUi,
    materialize_dashboard_ui,
)
from serve_skill_dashboard import (
    DashboardServerError,
    _validate_loopback_bind_host,
    create_handler,
    validate_sources,
)
from skill_eval_runtime import ManifestError, project_dashboard


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--workspace",
        type=Path,
        required=True,
        help="Locked eval workspace containing execution-plan.json.",
    )
    parser.add_argument(
        "--state",
        type=Path,
        help="Optional evolution-state.json outside the run workspace.",
    )
    parser.add_argument(
        "--task-root",
        type=Path,
        help="Append-only lead-Agent task ledger outside the evidence workspace.",
    )
    parser.add_argument(
        "--ui-dir",
        type=Path,
        help=(
            "Trusted local Dashboard build for development or offline use. "
            "When omitted, the launcher anonymously downloads the pinned bundle "
            "into a temporary directory and removes it on exit."
        ),
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="Preferred local port. Use 0 for an operating-system-assigned port.",
    )
    parser.add_argument(
        "--port-attempts",
        type=int,
        default=3,
        help="Number of consecutive ports to try without stopping another process.",
    )
    parser.add_argument(
        "--refresh-seconds",
        type=float,
        default=3.0,
        help=(
            "Reproject the run at this interval while serving so new execution "
            "evidence appears in the same page. Use 0 to disable."
        ),
    )
    parser.add_argument(
        "--open",
        action="store_true",
        help="Open the local control-plane URL after the server starts.",
    )
    parser.add_argument(
        "--serve-existing",
        action="store_true",
        help="Serve an existing dashboard-data.json without reprojecting the run.",
    )
    parser.add_argument(
        "--prepare-only",
        action="store_true",
        help=(
            "Project and validate the read model, then exit without downloading "
            "or starting the optional control plane."
        ),
    )
    parser.add_argument(
        "--user-approved-control-plane",
        action="store_true",
        help=(
            "Assert that the current request or a structured consent question "
            "explicitly authorized this temporary local control-plane session. "
            "Required unless --prepare-only is used."
        ),
    )
    args = parser.parse_args(argv)
    if args.port < 0 or args.port > 65535:
        parser.error("--port must be between 0 and 65535")
    if args.port_attempts < 1 or args.port_attempts > 20:
        parser.error("--port-attempts must be between 1 and 20")
    if args.refresh_seconds < 0 or args.refresh_seconds > 3600:
        parser.error("--refresh-seconds must be between 0 and 3600")
    if args.port > 0 and args.port + args.port_attempts - 1 > 65535:
        parser.error("the requested port range exceeds 65535")
    if not args.prepare_only and not args.user_approved_control_plane:
        parser.error(
            "starting the optional Dashboard requires explicit user approval; "
            "use an existing explicit Dashboard request or ask once with a "
            "standalone structured question, then pass "
            "--user-approved-control-plane only after an affirmative answer"
        )
    return args


def _port_candidates(preferred: int, attempts: int) -> list[int]:
    if preferred == 0:
        return [0]
    return list(range(preferred, preferred + attempts))


def _bind_server(
    *, host: str, preferred_port: int, attempts: int, handler: type
) -> ThreadingHTTPServer:
    last_error: OSError | None = None
    for port in _port_candidates(preferred_port, attempts):
        try:
            return ThreadingHTTPServer((host, port), handler)
        except OSError as error:
            last_error = error
            if error.errno not in {errno.EADDRINUSE, errno.EACCES}:
                raise
    assert last_error is not None
    raise DashboardServerError(
        "no dashboard port is available in the requested range; "
        "choose another --port or use --port 0"
    ) from last_error


def _control_plane_origin(host: str, port: int) -> str:
    authority = f"[{host}]" if ":" in host else host
    return f"http://{authority}:{port}"


def _control_plane_url(origin: str, session_token: str) -> str:
    return f"{origin}/skill-reviewer/#{urlencode({'session': session_token})}"


def prepare_dashboard(args: argparse.Namespace) -> dict[str, object]:
    workspace = args.workspace.resolve()
    if not args.serve_existing:
        project_dashboard(
            workspace=workspace,
            output=workspace / "dashboard-data.json",
            state_path=args.state,
        )
    report = validate_sources(workspace, args.task_root)
    return {
        **report,
        "dashboard_hosted": False,
        "control_plane_started": False,
        "projected": not args.serve_existing,
        "projection_source": (
            "fresh_run_projection" if not args.serve_existing else "existing_projection"
        ),
        "evidence_uploaded": False,
    }


def _projection_digest(workspace: Path) -> str:
    return hashlib.sha256((workspace / "dashboard-data.json").read_bytes()).hexdigest()


def _watch_projection(
    *,
    workspace: Path,
    state_path: Path | None,
    interval: float,
    initial_digest: str,
    stop: Event,
) -> None:
    """Keep one active run observable without replacing its evidence source."""
    previous_digest = initial_digest
    previous_error: str | None = None
    while not stop.wait(interval):
        try:
            data = project_dashboard(
                workspace=workspace,
                output=workspace / "dashboard-data.json",
                state_path=state_path,
            )
            current_digest = _projection_digest(workspace)
            if current_digest != previous_digest or previous_error is not None:
                run = data.get("run")
                print(
                    json.dumps(
                        {
                            "event": "dashboard_projection_updated",
                            "run_id": run.get("id") if isinstance(run, dict) else None,
                            "status": run.get("status") if isinstance(run, dict) else None,
                            "verification_level": (
                                run.get("verification_level")
                                if isinstance(run, dict)
                                else None
                            ),
                        },
                        ensure_ascii=False,
                    ),
                    file=sys.stderr,
                    flush=True,
                )
            previous_digest = current_digest
            previous_error = None
        except (ManifestError, OSError, ValueError) as error:
            message = str(error)
            if message != previous_error:
                print(
                    json.dumps(
                        {
                            "event": "dashboard_projection_failed",
                            "error": message,
                            "retrying": True,
                        },
                        ensure_ascii=False,
                    ),
                    file=sys.stderr,
                    flush=True,
                )
            previous_error = message


def _ui_report(ui: MaterializedDashboardUi) -> dict[str, object]:
    return {
        "ui_mode": ui.mode,
        "ui_downloaded": ui.temporary,
        "ui_temporary": ui.temporary,
        "ui_removed_on_exit": ui.temporary,
        "ui_integrity_verified": ui.integrity_verified,
        "ui_archive_sha256": ui.archive_sha256,
        "ui_tree_sha256": ui.tree_sha256,
        "ui_download_authenticated": False,
        "github_token_used": False,
    }


def _raise_keyboard_interrupt(_signum: int, _frame: object) -> None:
    raise KeyboardInterrupt


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        _validate_loopback_bind_host(args.host)
        report = prepare_dashboard(args)
        if args.prepare_only:
            print(
                json.dumps(
                    {
                        **report,
                        "ui_downloaded": False,
                        "ui_removed_on_exit": False,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0

        temporary_ui_removed = False
        with materialize_dashboard_ui(args.ui_dir) as ui:
            server: ThreadingHTTPServer | None = None
            projection_stop = Event()
            projection_thread: Thread | None = None
            session_token = secrets.token_urlsafe(32)
            try:
                handler = create_handler(
                    args.workspace,
                    args.task_root,
                    session_token=session_token,
                    static_ui_root=ui.root,
                )
                server = _bind_server(
                    host=args.host,
                    preferred_port=args.port,
                    attempts=args.port_attempts,
                    handler=handler,
                )
                bound_host, bound_port = server.server_address[:2]
                origin = _control_plane_origin(str(bound_host), int(bound_port))
                url = _control_plane_url(origin, session_token)
                launch_report = {
                    **report,
                    **_ui_report(ui),
                    "user_approved_control_plane": True,
                    "control_plane_started": True,
                    "base_url": origin,
                    "data_url": f"{origin}/dashboard-data.json",
                    "session_url": f"{origin}/dashboard-session.json",
                    "url": url,
                    "port": bound_port,
                    "projection_mode": (
                        "watching"
                        if not args.serve_existing and args.refresh_seconds > 0
                        else "static"
                    ),
                    "refresh_seconds": (
                        args.refresh_seconds
                        if not args.serve_existing and args.refresh_seconds > 0
                        else 0
                    ),
                    "dashboard_session": {
                        "contract": "skill-reviewer.dashboard-session",
                        "run_id": report.get("run_id"),
                        "page_url": url,
                        "local_origin": origin,
                        "owner": "lead_agent",
                        "lifecycle": "temporary-local-control-plane",
                        "evidence_transport": "same-origin-loopback-only",
                        "evidence_uploaded": False,
                        "capability_transport": "url-fragment-to-request-header",
                        "ui_integrity_verified": ui.integrity_verified,
                        "ui_downloaded": ui.temporary,
                        "ui_removed_on_exit": ui.temporary,
                        "browser_executes_actions": False,
                        "agent_handoff": {
                            "contract": "skill-reviewer.dashboard-agent-handoff",
                            "mode": "durable_local_ledger",
                            "agent_session_state": "unbound",
                            "can_wake_agent_session": False,
                            "persists_after_agent_session_end": True,
                            "task_root": report.get("task_root"),
                        },
                    },
                }
                print(json.dumps(launch_report, ensure_ascii=False), flush=True)
                if args.open and not webbrowser.open(url):
                    print(
                        "dashboard browser could not be opened automatically; "
                        "use the printed local URL",
                        file=sys.stderr,
                    )
                if not args.serve_existing and args.refresh_seconds > 0:
                    projection_thread = Thread(
                        target=_watch_projection,
                        kwargs={
                            "workspace": args.workspace.resolve(),
                            "state_path": args.state,
                            "interval": args.refresh_seconds,
                            "initial_digest": _projection_digest(
                                args.workspace.resolve()
                            ),
                            "stop": projection_stop,
                        },
                        name="skill-reviewer-dashboard-projector",
                        daemon=True,
                    )
                    projection_thread.start()
                if hasattr(signal, "SIGTERM"):
                    signal.signal(signal.SIGTERM, _raise_keyboard_interrupt)
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                projection_stop.set()
                if projection_thread is not None:
                    projection_thread.join(timeout=2)
                if server is not None:
                    server.server_close()
            temporary_ui_removed = ui.temporary
        if temporary_ui_removed:
            print(
                json.dumps(
                    {
                        "event": "dashboard_temporary_ui_removed",
                        "evidence_uploaded": False,
                    },
                    ensure_ascii=False,
                ),
                file=sys.stderr,
                flush=True,
            )
        return 0
    except (
        DashboardBundleError,
        DashboardServerError,
        ManifestError,
        OSError,
        ValueError,
    ) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
