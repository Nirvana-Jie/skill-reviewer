#!/usr/bin/env python3
"""Serve the built Evidence Lab and one workspace read model over local GETs."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import re
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import RLock
from urllib.parse import unquote, urlparse


class DashboardServerError(ValueError):
    """Raised when the read-only dashboard cannot be served safely."""


DIFF_ID_PATTERN = re.compile(r"[a-f0-9]{24}")
DIGEST_PATTERN = re.compile(r"[a-f0-9]{64}")
DASHBOARD_DIFF_RENDER_LIMIT_BYTES = 512 * 1024
# A single source byte can occupy six bytes when JSON escapes a control
# character (for example, ``\u0001``). Keep a bounded raw-file guard without
# rejecting otherwise valid 512 KiB UTF-8 previews after serialization.
DASHBOARD_DIFF_PAYLOAD_FILE_LIMIT_BYTES = (
    2 * DASHBOARD_DIFF_RENDER_LIMIT_BYTES * 6 + 128 * 1024
)


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_dashboard_snapshot(
    data_path: Path,
) -> tuple[dict[str, object], bytes]:
    try:
        body = data_path.read_bytes()
        data = json.loads(body.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DashboardServerError(f"dashboard read model is invalid: {error}") from error
    if not isinstance(data, dict) or data.get("contract") != (
        "skill-reviewer.dashboard-data"
    ):
        raise DashboardServerError(
            "dashboard read model contract must be skill-reviewer.dashboard-data"
        )
    return data, body


def _load_dashboard_data(data_path: Path) -> dict[str, object]:
    data, _body = _load_dashboard_snapshot(data_path)
    return data


def _validated_diff_routes(
    workspace: Path, data: dict[str, object]
) -> dict[str, tuple[Path, str]]:
    raw_diffs = data.get("diffs", [])
    if not isinstance(raw_diffs, list):
        raise DashboardServerError("dashboard diffs must be an array")
    payload_root = workspace / "dashboard-diffs"
    routes: dict[str, tuple[Path, str]] = {}
    for index, raw_diff in enumerate(raw_diffs):
        if not isinstance(raw_diff, dict):
            raise DashboardServerError(f"dashboard diff {index} must be an object")
        render_mode = raw_diff.get("render_mode")
        content_url = raw_diff.get("content_url")
        if render_mode not in {"lazy", "summary", "binary"}:
            raise DashboardServerError(
                f"dashboard diff {index} render mode is invalid"
            )
        payload_digest = raw_diff.get("payload_digest")
        if render_mode != "lazy":
            if content_url is not None or payload_digest is not None:
                raise DashboardServerError(
                    f"dashboard diff {index} exposes a payload outside lazy mode"
                )
            continue
        diff_id = raw_diff.get("id")
        if not isinstance(diff_id, str) or not DIFF_ID_PATTERN.fullmatch(diff_id):
            raise DashboardServerError(f"dashboard diff {index} id is invalid")
        expected_url = f"/dashboard-diffs/{diff_id}.json"
        if content_url != expected_url:
            raise DashboardServerError(
                f"dashboard diff {index} content URL is invalid"
            )
        if not isinstance(payload_digest, str) or not DIGEST_PATTERN.fullmatch(
            payload_digest
        ):
            raise DashboardServerError(
                f"dashboard diff {index} payload digest is invalid"
            )
        old_size = raw_diff.get("old_size")
        new_size = raw_diff.get("new_size")
        if any(
            type(size) is not int
            or size < 0
            or size > DASHBOARD_DIFF_RENDER_LIMIT_BYTES
            for size in (old_size, new_size)
        ):
            raise DashboardServerError(
                f"dashboard diff {index} preview size is invalid"
            )
        payload_path = payload_root / f"{diff_id}.json"
        if (
            payload_path.is_symlink()
            or not payload_path.is_file()
            or payload_path.resolve().parent != payload_root.resolve()
        ):
            raise DashboardServerError(
                f"dashboard diff payload does not exist: {payload_path}"
            )
        if payload_path.stat().st_size > DASHBOARD_DIFF_PAYLOAD_FILE_LIMIT_BYTES:
            raise DashboardServerError(
                f"dashboard diff payload exceeds the bounded preview limit: {payload_path}"
            )
        if _sha256_file(payload_path) != payload_digest:
            raise DashboardServerError(
                f"dashboard diff payload digest does not match its metadata: {payload_path}"
            )
        try:
            payload = json.loads(payload_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise DashboardServerError(
                f"dashboard diff payload is invalid: {payload_path}: {error}"
            ) from error
        if not isinstance(payload, dict) or any(
            payload.get(key) != expected
            for key, expected in (
                ("contract", "skill-reviewer.dashboard-diff"),
                ("id", diff_id),
                ("path", raw_diff.get("path")),
                ("old_digest", raw_diff.get("old_digest")),
                ("new_digest", raw_diff.get("new_digest")),
            )
        ):
            raise DashboardServerError(
                f"dashboard diff payload is not bound to its metadata: {payload_path}"
            )
        old_content = payload.get("old_content")
        new_content = payload.get("new_content")
        if (
            not isinstance(old_content, str)
            or not isinstance(new_content, str)
            or len(old_content.encode("utf-8")) != old_size
            or len(new_content.encode("utf-8")) != new_size
        ):
            raise DashboardServerError(
                f"dashboard diff payload size is not bound to its metadata: {payload_path}"
            )
        routes[expected_url] = (payload_path, payload_digest)
    return routes


def validate_sources(workspace: Path, static_root: Path) -> dict[str, object]:
    workspace = workspace.resolve()
    static_root = static_root.resolve()
    data_path = workspace / "dashboard-data.json"
    index_path = static_root / "index.html"
    if not data_path.is_file():
        raise DashboardServerError(
            f"dashboard read model does not exist: {data_path}"
        )
    data = _load_dashboard_data(data_path)
    diff_routes = _validated_diff_routes(workspace, data)
    if not index_path.is_file():
        raise DashboardServerError(
            f"dashboard build is missing: {index_path}; run pnpm dashboard:build"
        )
    return {
        "ok": True,
        "read_only": True,
        "workspace": str(workspace),
        "static_root": str(static_root),
        "run_id": data.get("run", {}).get("id")
        if isinstance(data.get("run"), dict)
        else None,
        "lazy_diff_count": len(diff_routes),
    }


def create_handler(workspace: Path, static_root: Path) -> type[BaseHTTPRequestHandler]:
    workspace = workspace.resolve()
    static_root = static_root.resolve()
    data_path = workspace / "dashboard-data.json"
    data, snapshot_body = _load_dashboard_snapshot(data_path)
    initial_diff_routes = _validated_diff_routes(workspace, data)
    snapshot_digest = _sha256_bytes(snapshot_body)
    known_diff_routes = dict(initial_diff_routes)
    snapshot_lock = RLock()

    def refresh_snapshot() -> bytes:
        nonlocal snapshot_body, snapshot_digest
        with snapshot_lock:
            next_data, next_body = _load_dashboard_snapshot(data_path)
            next_digest = _sha256_bytes(next_body)
            if next_digest == snapshot_digest:
                return snapshot_body
            next_routes = _validated_diff_routes(workspace, next_data)
            for route, binding in next_routes.items():
                previous = known_diff_routes.get(route)
                if previous is not None and previous[1] != binding[1]:
                    raise DashboardServerError(
                        f"dashboard diff route changed content identity: {route}"
                    )
            known_diff_routes.update(next_routes)
            snapshot_body = next_body
            snapshot_digest = next_digest
            return snapshot_body

    def resolve_diff_route(request_path: str) -> tuple[Path, str] | None:
        with snapshot_lock:
            return known_diff_routes.get(request_path)

    class Handler(BaseHTTPRequestHandler):
        server_version = "SkillReviewerDashboard"

        def _resolve_request(
            self,
        ) -> tuple[Path | None, str, str | None, bytes | None]:
            request_path = unquote(urlparse(self.path).path)
            if request_path == "/dashboard-data.json":
                return (
                    None,
                    "application/json; charset=utf-8",
                    None,
                    refresh_snapshot(),
                )
            diff_route = resolve_diff_route(request_path)
            if diff_route is not None:
                path, payload_digest = diff_route
                return (
                    path,
                    "application/json; charset=utf-8",
                    payload_digest,
                    None,
                )
            if request_path.startswith("/dashboard-diffs/"):
                raise DashboardServerError(
                    "diff payload is not registered by the dashboard read model"
                )
            relative = request_path.lstrip("/") or "index.html"
            candidate = (static_root / relative).resolve()
            try:
                candidate.relative_to(static_root)
            except ValueError as error:
                raise DashboardServerError("request leaves the dashboard build") from error
            if candidate.is_dir():
                candidate = candidate / "index.html"
            if not candidate.is_file() and "." not in Path(relative).name:
                candidate = static_root / "index.html"
            content_type = mimetypes.guess_type(candidate.name)[0] or (
                "application/octet-stream"
            )
            if content_type.startswith("text/") or content_type in {
                "application/javascript",
                "application/json",
            }:
                content_type += "; charset=utf-8"
            return candidate, content_type, None, None

        def _serve(self, include_body: bool) -> None:
            try:
                path, content_type, expected_digest, body = self._resolve_request()
            except DashboardServerError as error:
                self.send_error(HTTPStatus.BAD_REQUEST, str(error))
                return
            if path is not None and not path.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            try:
                if path is not None and expected_digest is not None and (
                    path.is_symlink()
                    or path.stat().st_size > DASHBOARD_DIFF_PAYLOAD_FILE_LIMIT_BYTES
                ):
                    raise DashboardServerError(
                        "dashboard diff payload changed after validation"
                    )
                if body is None and path is not None:
                    body = path.read_bytes()
                if body is None:
                    raise DashboardServerError("dashboard response has no body")
                if expected_digest is not None and (
                    len(body) > DASHBOARD_DIFF_PAYLOAD_FILE_LIMIT_BYTES
                    or _sha256_bytes(body) != expected_digest
                ):
                    raise DashboardServerError(
                        "dashboard diff payload digest changed after validation"
                    )
            except DashboardServerError as error:
                self.send_error(HTTPStatus.BAD_REQUEST, str(error))
                return
            except OSError:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; worker-src 'self'")
            self.send_header(
                "Cache-Control",
                "no-store"
                if path is None or expected_digest is not None
                else "public, max-age=300",
            )
            self.end_headers()
            if include_body:
                self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
            self._serve(include_body=True)

        def do_HEAD(self) -> None:  # noqa: N802 - stdlib callback name
            self._serve(include_body=False)

        def do_POST(self) -> None:  # noqa: N802 - stdlib callback name
            self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "dashboard is read-only")

        def log_message(self, format: str, *args: object) -> None:
            print(f"dashboard {self.address_string()} {format % args}", file=sys.stderr)

    return Handler


def parse_args(argv: list[str]) -> argparse.Namespace:
    repository = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--static-root", type=Path, default=repository / "dashboard" / "dist")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4174)
    parser.add_argument("--check", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        report = validate_sources(args.workspace, args.static_root)
        if args.check:
            print(json.dumps(report, ensure_ascii=False, indent=2))
            return 0
        handler = create_handler(args.workspace, args.static_root)
        server = ThreadingHTTPServer((args.host, args.port), handler)
    except (DashboardServerError, OSError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 2
    host, port = server.server_address[:2]
    print(
        json.dumps(
            {**report, "url": f"http://{host}:{port}"}, ensure_ascii=False
        ),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
