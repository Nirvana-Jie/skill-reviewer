#!/usr/bin/env python3
"""Package, verify, or temporarily materialize the local Dashboard UI bundle.

The interactive UI is deliberately not part of the installable Skill package.
The launcher downloads an anonymous, content-addressed release archive, verifies
both the archive and its extracted file tree, and removes the UI when the local
control plane exits.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import urllib.error
import urllib.request
import zipfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterator
from urllib.parse import urlparse


class DashboardBundleError(ValueError):
    """Raised when the Dashboard UI supply-chain contract is not satisfied."""


BUNDLE_CONTRACT = "skill-reviewer.dashboard-ui-bundle"
CANONICAL_RELEASE_BASE = (
    "https://github.com/Nirvana-Jie/skill-reviewer/releases/download/"
    "dashboard-ui-assets"
)
DEFAULT_MANIFEST_PATH = (
    Path(__file__).resolve().parent.parent
    / "assets"
    / "dashboard-ui-bundle.json"
)
HARD_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
HARD_MAX_UNPACKED_BYTES = 96 * 1024 * 1024
HARD_MAX_FILES = 256
DOWNLOAD_TIMEOUT_SECONDS = 30
DOWNLOAD_CHUNK_BYTES = 128 * 1024
FILE_CHUNK_BYTES = 1024 * 1024
SHA256_PATTERN = re.compile(r"[a-f0-9]{64}")
SAFE_PATH_PART_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
ALLOWED_REDIRECT_HOSTS = {
    "github.com",
    "objects.githubusercontent.com",
    "github-releases.githubusercontent.com",
    "release-assets.githubusercontent.com",
}
ALLOWED_ASSET_SUFFIXES = {
    ".css",
    ".js",
    ".json",
    ".png",
    ".svg",
    ".wasm",
    ".woff2",
}
MANIFEST_FIELDS = {
    "contract",
    "asset_url",
    "archive_sha256",
    "tree_sha256",
    "entrypoint",
    "max_archive_bytes",
    "max_unpacked_bytes",
    "max_files",
}


@dataclass(frozen=True)
class DashboardBundleManifest:
    asset_url: str
    archive_sha256: str
    tree_sha256: str
    entrypoint: str
    max_archive_bytes: int
    max_unpacked_bytes: int
    max_files: int


@dataclass(frozen=True)
class MaterializedDashboardUi:
    root: Path
    mode: str
    temporary: bool
    integrity_verified: bool
    archive_sha256: str | None
    tree_sha256: str


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(FILE_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _bounded_int(value: object, label: str, hard_limit: int) -> int:
    if type(value) is not int or value < 1 or value > hard_limit:
        raise DashboardBundleError(
            f"Dashboard bundle {label} must be between 1 and {hard_limit}"
        )
    return value


def _validate_asset_url(raw: object, tree_sha256: str) -> str:
    if not isinstance(raw, str):
        raise DashboardBundleError("Dashboard bundle asset_url must be a string")
    parsed = urlparse(raw)
    expected_path = (
        "/Nirvana-Jie/skill-reviewer/releases/download/dashboard-ui-assets/"
        f"dashboard-ui-{tree_sha256}.zip"
    )
    if (
        parsed.scheme != "https"
        or parsed.hostname != "github.com"
        or parsed.port not in {None, 443}
        or parsed.username
        or parsed.password
        or parsed.path != expected_path
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise DashboardBundleError(
            "Dashboard bundle asset_url must be the canonical content-addressed "
            "GitHub Release asset"
        )
    return raw


def load_manifest(path: Path = DEFAULT_MANIFEST_PATH) -> DashboardBundleManifest:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DashboardBundleError(
            f"Dashboard UI manifest is unavailable or invalid: {path}"
        ) from error
    if not isinstance(raw, dict) or set(raw) != MANIFEST_FIELDS:
        raise DashboardBundleError("Dashboard UI manifest fields are invalid")
    if raw.get("contract") != BUNDLE_CONTRACT:
        raise DashboardBundleError("Dashboard UI manifest contract is invalid")
    archive_sha256 = raw.get("archive_sha256")
    tree_sha256 = raw.get("tree_sha256")
    if not isinstance(archive_sha256, str) or not SHA256_PATTERN.fullmatch(
        archive_sha256
    ):
        raise DashboardBundleError("Dashboard bundle archive digest is invalid")
    if not isinstance(tree_sha256, str) or not SHA256_PATTERN.fullmatch(tree_sha256):
        raise DashboardBundleError("Dashboard bundle tree digest is invalid")
    entrypoint = raw.get("entrypoint")
    if entrypoint != "index.html":
        raise DashboardBundleError("Dashboard bundle entrypoint must be index.html")
    return DashboardBundleManifest(
        asset_url=_validate_asset_url(raw.get("asset_url"), tree_sha256),
        archive_sha256=archive_sha256,
        tree_sha256=tree_sha256,
        entrypoint=entrypoint,
        max_archive_bytes=_bounded_int(
            raw.get("max_archive_bytes"),
            "max_archive_bytes",
            HARD_MAX_ARCHIVE_BYTES,
        ),
        max_unpacked_bytes=_bounded_int(
            raw.get("max_unpacked_bytes"),
            "max_unpacked_bytes",
            HARD_MAX_UNPACKED_BYTES,
        ),
        max_files=_bounded_int(raw.get("max_files"), "max_files", HARD_MAX_FILES),
    )


def _safe_relative_path(raw: str) -> PurePosixPath:
    if (
        not raw
        or len(raw) > 512
        or "\x00" in raw
        or "\\" in raw
        or raw.startswith("/")
    ):
        raise DashboardBundleError("Dashboard bundle contains an unsafe path")
    path = PurePosixPath(raw)
    if any(
        part in {"", ".", ".."} or not SAFE_PATH_PART_PATTERN.fullmatch(part)
        for part in path.parts
    ):
        raise DashboardBundleError(
            f"Dashboard bundle path is not portable: {raw!r}"
        )
    return path


def _asset_path_is_allowed(path: PurePosixPath) -> bool:
    if path.as_posix() in {"index.html", "favicon.svg"}:
        return True
    return (
        2 <= len(path.parts) <= 4
        and path.parts[0] == "assets"
        and path.suffix.lower() in ALLOWED_ASSET_SUFFIXES
    )


def _asset_directory_is_allowed(path: PurePosixPath) -> bool:
    return 1 <= len(path.parts) <= 3 and path.parts[0] == "assets"


def _walk_ui_files(
    root: Path,
    *,
    max_files: int,
    max_unpacked_bytes: int,
) -> list[tuple[str, Path, int]]:
    if root.is_symlink() or not root.is_dir():
        raise DashboardBundleError("Dashboard UI root is not a safe directory")
    files: list[tuple[str, Path, int]] = []
    total_size = 0
    seen_casefold: set[str] = set()
    for current, directory_names, file_names in os.walk(root, followlinks=False):
        current_path = Path(current)
        for directory_name in directory_names:
            directory = current_path / directory_name
            if directory.is_symlink():
                raise DashboardBundleError("Dashboard UI tree contains a symlink")
            relative = directory.relative_to(root).as_posix()
            portable = _safe_relative_path(relative)
            if not _asset_directory_is_allowed(portable):
                raise DashboardBundleError(
                    f"Dashboard UI tree contains an unexpected directory: {relative}"
                )
        for file_name in file_names:
            path = current_path / file_name
            if path.is_symlink() or not path.is_file():
                raise DashboardBundleError(
                    "Dashboard UI tree contains a non-regular file"
                )
            relative = path.relative_to(root).as_posix()
            portable = _safe_relative_path(relative)
            if not _asset_path_is_allowed(portable):
                raise DashboardBundleError(
                    f"Dashboard UI tree contains an unexpected file: {relative}"
                )
            folded = relative.casefold()
            if folded in seen_casefold:
                raise DashboardBundleError(
                    "Dashboard UI tree contains duplicate case-insensitive paths"
                )
            seen_casefold.add(folded)
            size = path.stat().st_size
            total_size += size
            if len(files) + 1 > max_files or total_size > max_unpacked_bytes:
                raise DashboardBundleError("Dashboard UI tree exceeds its size limits")
            files.append((relative, path, size))
    files.sort(key=lambda item: item[0].encode("utf-8"))
    if not any(relative == "index.html" for relative, _path, _size in files):
        raise DashboardBundleError("Dashboard UI tree has no index.html")
    return files


def tree_digest(
    root: Path,
    *,
    max_files: int = HARD_MAX_FILES,
    max_unpacked_bytes: int = HARD_MAX_UNPACKED_BYTES,
) -> str:
    digest = hashlib.sha256()
    for relative, path, size in _walk_ui_files(
        root,
        max_files=max_files,
        max_unpacked_bytes=max_unpacked_bytes,
    ):
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(size).encode("ascii"))
        digest.update(b"\0")
        digest.update(_sha256_file(path).encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def _validate_redirect_target(raw: str) -> None:
    parsed = urlparse(raw)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in ALLOWED_REDIRECT_HOSTS
        or parsed.port not in {None, 443}
        or parsed.username
        or parsed.password
        or parsed.fragment
    ):
        raise DashboardBundleError(
            "Dashboard bundle download redirected outside trusted HTTPS hosts"
        )


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(  # type: ignore[override]
        self,
        req: urllib.request.Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> urllib.request.Request | None:
        _validate_redirect_target(newurl)
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None:
            redirected.remove_header("Authorization")
            redirected.remove_header("Cookie")
        return redirected


def download_archive(manifest: DashboardBundleManifest, destination: Path) -> None:
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    request = urllib.request.Request(
        manifest.asset_url,
        headers={
            "Accept": "application/octet-stream",
            "Cache-Control": "no-store",
            "User-Agent": "skill-reviewer-dashboard-bundle",
        },
        method="GET",
    )
    opener = urllib.request.build_opener(_SafeRedirectHandler())
    temporary = destination.with_name(f".{destination.name}.part")
    try:
        with opener.open(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            _validate_redirect_target(response.geturl())
            content_length = response.headers.get("Content-Length")
            if content_length is not None:
                try:
                    declared_size = int(content_length)
                except ValueError as error:
                    raise DashboardBundleError(
                        "Dashboard bundle Content-Length is invalid"
                    ) from error
                if declared_size < 1 or declared_size > manifest.max_archive_bytes:
                    raise DashboardBundleError(
                        "Dashboard bundle archive exceeds its download limit"
                    )
            total = 0
            with temporary.open("xb") as handle:
                while True:
                    chunk = response.read(DOWNLOAD_CHUNK_BYTES)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > manifest.max_archive_bytes:
                        raise DashboardBundleError(
                            "Dashboard bundle archive exceeds its download limit"
                        )
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
        if total < 1 or _sha256_file(temporary) != manifest.archive_sha256:
            raise DashboardBundleError("Dashboard bundle archive digest does not match")
        temporary.chmod(0o600)
        temporary.replace(destination)
    except (urllib.error.URLError, TimeoutError) as error:
        raise DashboardBundleError(
            "Dashboard UI could not be downloaded anonymously; check network access "
            "or use --ui-dir with a trusted local build"
        ) from error
    finally:
        temporary.unlink(missing_ok=True)


def _zip_entry_kind(info: zipfile.ZipInfo) -> str:
    if info.create_system != 3:
        raise DashboardBundleError(
            "Dashboard bundle entries must carry Unix file type metadata"
        )
    mode = info.external_attr >> 16
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISREG(mode):
        return "file"
    raise DashboardBundleError("Dashboard bundle contains a non-regular entry")


def extract_archive(
    archive: Path,
    destination: Path,
    manifest: DashboardBundleManifest,
) -> str:
    if destination.exists():
        if (
            destination.is_symlink()
            or not destination.is_dir()
            or any(destination.iterdir())
        ):
            raise DashboardBundleError(
                "Dashboard bundle extraction directory must be empty"
            )
    else:
        destination.mkdir(mode=0o700, parents=True)
    seen: set[str] = set()
    seen_casefold: set[str] = set()
    file_count = 0
    unpacked_size = 0
    try:
        with zipfile.ZipFile(archive, "r") as bundle:
            for info in bundle.infolist():
                path = _safe_relative_path(info.filename.rstrip("/"))
                relative = path.as_posix()
                folded = relative.casefold()
                if relative in seen or folded in seen_casefold:
                    raise DashboardBundleError(
                        "Dashboard bundle contains a duplicate path"
                    )
                seen.add(relative)
                seen_casefold.add(folded)
                if info.flag_bits & 0x1:
                    raise DashboardBundleError(
                        "Dashboard bundle contains an encrypted entry"
                    )
                if info.compress_type not in {
                    zipfile.ZIP_STORED,
                    zipfile.ZIP_DEFLATED,
                }:
                    raise DashboardBundleError(
                        "Dashboard bundle uses an unsupported compression method"
                    )
                kind = _zip_entry_kind(info)
                target = destination.joinpath(*path.parts)
                if kind == "directory":
                    if not _asset_directory_is_allowed(path):
                        raise DashboardBundleError(
                            f"Dashboard bundle contains an unexpected directory: {relative}"
                        )
                    target.mkdir(mode=0o700, parents=True, exist_ok=True)
                    target.chmod(0o700)
                    continue
                if not _asset_path_is_allowed(path):
                    raise DashboardBundleError(
                        f"Dashboard bundle contains an unexpected file: {relative}"
                    )
                file_count += 1
                unpacked_size += info.file_size
                if (
                    info.file_size < 0
                    or info.compress_size < 0
                    or file_count > manifest.max_files
                    or unpacked_size > manifest.max_unpacked_bytes
                ):
                    raise DashboardBundleError(
                        "Dashboard bundle exceeds its extraction limits"
                    )
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                written = 0
                with bundle.open(info, "r") as source, target.open("xb") as output:
                    while True:
                        chunk = source.read(DOWNLOAD_CHUNK_BYTES)
                        if not chunk:
                            break
                        written += len(chunk)
                        if written > info.file_size:
                            raise DashboardBundleError(
                                "Dashboard bundle entry expanded beyond its declared size"
                            )
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                if written != info.file_size:
                    raise DashboardBundleError(
                        "Dashboard bundle entry size does not match its metadata"
                    )
                target.chmod(0o600)
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile, RuntimeError) as error:
        raise DashboardBundleError("Dashboard bundle archive is invalid") from error
    digest = tree_digest(
        destination,
        max_files=manifest.max_files,
        max_unpacked_bytes=manifest.max_unpacked_bytes,
    )
    if digest != manifest.tree_sha256:
        raise DashboardBundleError("Dashboard bundle tree digest does not match")
    if not (destination / manifest.entrypoint).is_file():
        raise DashboardBundleError("Dashboard bundle entrypoint is missing")
    return digest


def package_ui(
    ui_dir: Path,
    output_dir: Path,
    *,
    max_archive_bytes: int,
    max_unpacked_bytes: int,
    max_files: int,
) -> tuple[Path, DashboardBundleManifest]:
    ui_dir = ui_dir.resolve()
    files = _walk_ui_files(
        ui_dir,
        max_files=max_files,
        max_unpacked_bytes=max_unpacked_bytes,
    )
    digest = tree_digest(
        ui_dir,
        max_files=max_files,
        max_unpacked_bytes=max_unpacked_bytes,
    )
    output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    archive = output_dir / f"dashboard-ui-{digest}.zip"
    temporary = output_dir / f".{archive.name}.part"
    try:
        with zipfile.ZipFile(
            temporary,
            "x",
            compression=zipfile.ZIP_STORED,
            allowZip64=False,
        ) as bundle:
            for relative, path, _size in files:
                info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.compress_type = zipfile.ZIP_STORED
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                info.flag_bits = 0
                bundle.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_STORED)
        archive_size = temporary.stat().st_size
        if archive_size < 1 or archive_size > max_archive_bytes:
            raise DashboardBundleError("Dashboard bundle archive exceeds its size limit")
        temporary.chmod(0o600)
        temporary.replace(archive)
    finally:
        temporary.unlink(missing_ok=True)
    manifest = DashboardBundleManifest(
        asset_url=f"{CANONICAL_RELEASE_BASE}/{archive.name}",
        archive_sha256=_sha256_file(archive),
        tree_sha256=digest,
        entrypoint="index.html",
        max_archive_bytes=max_archive_bytes,
        max_unpacked_bytes=max_unpacked_bytes,
        max_files=max_files,
    )
    return archive, manifest


def manifest_dict(manifest: DashboardBundleManifest) -> dict[str, object]:
    return {
        "contract": BUNDLE_CONTRACT,
        "asset_url": manifest.asset_url,
        "archive_sha256": manifest.archive_sha256,
        "tree_sha256": manifest.tree_sha256,
        "entrypoint": manifest.entrypoint,
        "max_archive_bytes": manifest.max_archive_bytes,
        "max_unpacked_bytes": manifest.max_unpacked_bytes,
        "max_files": manifest.max_files,
    }


def write_manifest(path: Path, manifest: DashboardBundleManifest) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(
        json.dumps(manifest_dict(manifest), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


@contextmanager
def materialize_dashboard_ui(
    ui_dir: Path | None = None,
    *,
    manifest_path: Path = DEFAULT_MANIFEST_PATH,
) -> Iterator[MaterializedDashboardUi]:
    if ui_dir is not None:
        root = ui_dir.resolve()
        digest = tree_digest(root)
        yield MaterializedDashboardUi(
            root=root,
            mode="trusted_local_override",
            temporary=False,
            integrity_verified=False,
            archive_sha256=None,
            tree_sha256=digest,
        )
        return
    manifest = load_manifest(manifest_path)
    with tempfile.TemporaryDirectory(prefix="skill-reviewer-dashboard-") as raw_root:
        temporary_root = Path(raw_root)
        temporary_root.chmod(0o700)
        archive = temporary_root / "dashboard-ui.zip"
        ui_root = temporary_root / "ui"
        download_archive(manifest, archive)
        digest = extract_archive(archive, ui_root, manifest)
        archive.unlink(missing_ok=True)
        yield MaterializedDashboardUi(
            root=ui_root,
            mode="temporary_verified_bundle",
            temporary=True,
            integrity_verified=True,
            archive_sha256=manifest.archive_sha256,
            tree_sha256=digest,
        )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    package = subparsers.add_parser("package", help="Create a deterministic UI archive")
    package.add_argument("--ui-dir", type=Path, required=True)
    package.add_argument("--output-dir", type=Path, required=True)
    package.add_argument("--manifest-output", type=Path)
    package.add_argument("--max-archive-bytes", type=int, default=12 * 1024 * 1024)
    package.add_argument("--max-unpacked-bytes", type=int, default=32 * 1024 * 1024)
    package.add_argument("--max-files", type=int, default=96)

    verify = subparsers.add_parser("verify", help="Verify and safely extract an archive")
    verify.add_argument("--manifest", type=Path, required=True)
    verify.add_argument("--archive", type=Path, required=True)
    verify.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else os.sys.argv[1:])
    try:
        if args.command == "package":
            max_archive_bytes = _bounded_int(
                args.max_archive_bytes,
                "max_archive_bytes",
                HARD_MAX_ARCHIVE_BYTES,
            )
            max_unpacked_bytes = _bounded_int(
                args.max_unpacked_bytes,
                "max_unpacked_bytes",
                HARD_MAX_UNPACKED_BYTES,
            )
            max_files = _bounded_int(args.max_files, "max_files", HARD_MAX_FILES)
            archive, manifest = package_ui(
                args.ui_dir,
                args.output_dir,
                max_archive_bytes=max_archive_bytes,
                max_unpacked_bytes=max_unpacked_bytes,
                max_files=max_files,
            )
            if args.manifest_output is not None:
                write_manifest(args.manifest_output, manifest)
            print(
                json.dumps(
                    {
                        "ok": True,
                        "archive": str(archive),
                        "manifest": manifest_dict(manifest),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        manifest = load_manifest(args.manifest)
        archive = args.archive.resolve()
        if archive.is_symlink() or not archive.is_file():
            raise DashboardBundleError("Dashboard bundle archive is not a safe file")
        if archive.stat().st_size > manifest.max_archive_bytes:
            raise DashboardBundleError("Dashboard bundle archive exceeds its size limit")
        if _sha256_file(archive) != manifest.archive_sha256:
            raise DashboardBundleError("Dashboard bundle archive digest does not match")
        digest = extract_archive(archive, args.output_dir, manifest)
        print(
            json.dumps(
                {
                    "ok": True,
                    "tree_sha256": digest,
                    "output_dir": str(args.output_dir.resolve()),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    except (DashboardBundleError, OSError) as error:
        if args.command == "verify" and args.output_dir.exists():
            shutil.rmtree(args.output_dir, ignore_errors=True)
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
