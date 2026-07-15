#!/usr/bin/env python3
"""Serve the built Evidence Lab and one workspace read model over local GETs."""

from __future__ import annotations

import argparse
import json
import mimetypes
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


class DashboardServerError(ValueError):
    """Raised when the read-only dashboard cannot be served safely."""


def validate_sources(workspace: Path, static_root: Path) -> dict[str, object]:
    workspace = workspace.resolve()
    static_root = static_root.resolve()
    data_path = workspace / "dashboard-data.json"
    index_path = static_root / "index.html"
    if not data_path.is_file():
        raise DashboardServerError(
            f"dashboard read model does not exist: {data_path}"
        )
    try:
        data = json.loads(data_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DashboardServerError(f"dashboard read model is invalid: {error}") from error
    if not isinstance(data, dict) or data.get("schema_version") != (
        "skill-reviewer.dashboard-data.v1"
    ):
        raise DashboardServerError(
            "dashboard read model schema must be skill-reviewer.dashboard-data.v1"
        )
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
    }


def create_handler(workspace: Path, static_root: Path) -> type[BaseHTTPRequestHandler]:
    workspace = workspace.resolve()
    static_root = static_root.resolve()
    data_path = workspace / "dashboard-data.json"

    class Handler(BaseHTTPRequestHandler):
        server_version = "SkillReviewerDashboard/1"

        def _resolve_request(self) -> tuple[Path, str]:
            request_path = unquote(urlparse(self.path).path)
            if request_path == "/dashboard-data.json":
                return data_path, "application/json; charset=utf-8"
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
            return candidate, content_type

        def _serve(self, include_body: bool) -> None:
            try:
                path, content_type = self._resolve_request()
            except DashboardServerError as error:
                self.send_error(HTTPStatus.BAD_REQUEST, str(error))
                return
            if not path.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            body = path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'")
            self.send_header(
                "Cache-Control",
                "no-store" if path == data_path else "public, max-age=300",
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
