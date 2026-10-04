#!/usr/bin/env python3
"""Safely extract a static Web OS ZIP and prepare it for the reusable Tauri shell."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

MAX_ENTRIES = 50_000
MAX_FILE_SIZE = 512 * 1024 * 1024
MAX_TOTAL_SIZE = 2 * 1024 * 1024 * 1024
MAX_RATIO = 250
RUNTIME_FILENAME = "__htmltoapp_runtime.js"
APP_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._()\-]{0,63}$")
PACKAGE_ID_RE = re.compile(r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?$")


class ProjectError(ValueError):
    """An input project cannot be safely packaged."""


def safe_member_path(name: str) -> tuple[str, bool]:
    """Return a normalized relative archive path and whether it is a directory."""
    if not name or "\\" in name or "\x00" in name:
        raise ProjectError(f"Unsafe ZIP path: {name!r}")
    if name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        raise ProjectError(f"Absolute paths are not allowed in project ZIPs: {name!r}")
    is_directory = name.endswith("/")
    clean = name[:-1] if is_directory else name
    if not clean:
        raise ProjectError("The ZIP contains an empty path.")
    parts = clean.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ProjectError(f"Path traversal or an invalid path was found: {name!r}")
    if any(any(char in part for char in '<>:"|?*') for part in parts):
        raise ProjectError(f"A ZIP path contains characters unsupported by Windows: {name!r}")
    if any(part.endswith((".", " ")) for part in parts):
        raise ProjectError(f"A ZIP path has a Windows-ambiguous name: {name!r}")
    reserved = re.compile(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.IGNORECASE)
    if any(reserved.match(part) for part in parts):
        raise ProjectError(f"A ZIP path uses a reserved Windows filename: {name!r}")
    return PurePosixPath(*parts).as_posix(), is_directory


def validate_metadata(name: Any, package_id: Any, version: Any, description: Any = "") -> dict[str, str]:
    app_name = str(name or "").strip()
    identifier = str(package_id or "").strip()
    app_version = str(version or "").strip()
    app_description = str(description or "").strip()
    if not APP_NAME_RE.fullmatch(app_name):
        raise ProjectError("App name must be 1–64 characters and use letters, numbers, spaces, dots, dashes, underscores or parentheses.")
    if not PACKAGE_ID_RE.fullmatch(identifier):
        raise ProjectError("Package ID must be lowercase reverse-domain format with at least three parts, e.g. com.example.myapp.")
    if not VERSION_RE.fullmatch(app_version):
        raise ProjectError("Version must look like 1.0.0 or 1.0.0-beta.1.")
    if len(app_description) > 300:
        raise ProjectError("App description must be 300 characters or fewer.")
    return {"name": app_name, "packageId": identifier, "version": app_version, "description": app_description}


def safe_extract(archive: Path, destination: Path) -> tuple[Path, int]:
    """Extract entries without following links or permitting path traversal."""
    if not archive.is_file():
        raise ProjectError(f"Project ZIP does not exist: {archive}")
    if destination.exists():
        raise ProjectError(f"Extraction directory already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp_root = Path(tempfile.mkdtemp(prefix=".htmltoapp-extract-", dir=destination.parent))
    seen: set[str] = set()
    entries: list[tuple[zipfile.ZipInfo, str, bool]] = []
    total_uncompressed = 0

    try:
        try:
            zipped = zipfile.ZipFile(archive)
        except (OSError, zipfile.BadZipFile) as exc:
            raise ProjectError(f"Could not open project ZIP: {exc}") from exc
        with zipped:
            infos = zipped.infolist()
            if len(infos) > MAX_ENTRIES:
                raise ProjectError(f"The archive has more than {MAX_ENTRIES:,} entries.")
            for info in infos:
                if info.flag_bits & 0x1:
                    raise ProjectError("Password-protected ZIP files are not supported.")
                path, is_directory = safe_member_path(info.filename)
                mode = (info.external_attr >> 16) & 0xFFFF
                kind = stat.S_IFMT(mode)
                if kind == stat.S_IFLNK:
                    raise ProjectError(f"Symbolic links are not allowed in project ZIPs: {path}")
                if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                    raise ProjectError(f"Special files are not allowed in project ZIPs: {path}")
                if not is_directory:
                    folded = path.casefold()
                    if folded in seen:
                        raise ProjectError(f"The ZIP contains duplicate or case-conflicting paths: {path}")
                    seen.add(folded)
                    if info.file_size > MAX_FILE_SIZE:
                        raise ProjectError(f"{path} exceeds the 512 MB per-file extraction limit.")
                    if info.file_size and not info.compress_size:
                        raise ProjectError(f"The compressed size for {path} is invalid.")
                    if info.compress_size and info.file_size / info.compress_size > MAX_RATIO:
                        raise ProjectError(f"The compression ratio for {path} is too high; the archive may be a ZIP bomb.")
                    total_uncompressed += info.file_size
                    if total_uncompressed > MAX_TOTAL_SIZE:
                        raise ProjectError("The uncompressed project exceeds the 2 GB safety limit.")
                entries.append((info, path, is_directory))

            for info, path, is_directory in entries:
                output_path = temp_root.joinpath(*PurePosixPath(path).parts)
                if not output_path.resolve().is_relative_to(temp_root.resolve()):
                    raise ProjectError(f"ZIP path escaped its extraction directory: {path}")
                if is_directory:
                    output_path.mkdir(parents=True, exist_ok=True)
                    continue
                output_path.parent.mkdir(parents=True, exist_ok=True)
                try:
                    with zipped.open(info, "r") as source, output_path.open("xb") as target:
                        shutil.copyfileobj(source, target, length=1024 * 1024)
                except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
                    raise ProjectError(f"Could not extract {path}: {exc}") from exc

        root = temp_root
        if not (root / "index.html").is_file():
            top_level = {path.split("/", 1)[0] for _, path, is_dir in entries if not is_dir}
            if len(top_level) == 1:
                possible_root = root / next(iter(top_level))
                if (possible_root / "index.html").is_file():
                    root = possible_root
            if not (root / "index.html").is_file():
                raise ProjectError("Could not find index.html at the ZIP root (or inside one top-level folder).")

        # Copy a single wrapper folder into the final staging directory without losing nested paths.
        if root != temp_root:
            flattened = temp_root.parent / f"{temp_root.name}-flattened"
            shutil.copytree(root, flattened)
            shutil.rmtree(temp_root)
            temp_root = flattened

        if any(path.casefold() == RUNTIME_FILENAME.casefold() for path in seen):
            raise ProjectError(f"The filename {RUNTIME_FILENAME} is reserved for the native Web OS bridge.")

        os.replace(temp_root, destination)
        return destination, sum(1 for _, _, is_dir in entries if not is_dir)
    except Exception:
        shutil.rmtree(temp_root, ignore_errors=True)
        flattened = temp_root.parent / f"{temp_root.name}-flattened"
        if flattened.exists():
            shutil.rmtree(flattened, ignore_errors=True)
        raise


def default_app_name(archive: Path) -> str:
    stem = archive.stem
    cleaned = re.sub(r"[^A-Za-z0-9 ._()\-]+", " ", stem).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)[:64]
    return cleaned if cleaned and cleaned[0].isalnum() else "My Web App"


def read_and_write_manifest(project_dir: Path, args: argparse.Namespace) -> dict[str, str]:
    manifest_path = project_dir / "app.json"
    manifest: dict[str, Any] = {}
    if manifest_path.is_file():
        try:
            parsed = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProjectError(f"app.json must be valid UTF-8 JSON: {exc}") from exc
        if not isinstance(parsed, dict):
            raise ProjectError("app.json must contain a JSON object.")
        manifest = parsed

    fallback_name = default_app_name(Path(args.archive))
    name = args.name if args.name is not None and args.name != "" else manifest.get("name", fallback_name)
    package_id = args.package_id if args.package_id is not None and args.package_id != "" else manifest.get("packageId", manifest.get("identifier", "com.example.webos"))
    version = args.version if args.version is not None and args.version != "" else manifest.get("version", "1.0.0")
    description = args.description if args.description is not None and args.description != "" else manifest.get("description", "")
    metadata = validate_metadata(name, package_id, version, description)
    manifest.update(metadata)
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return metadata


def inject_runtime(project_dir: Path, runtime_api: Path) -> None:
    if not runtime_api.is_file():
        raise ProjectError(f"The shared Web OS API file is missing: {runtime_api}")
    index_path = project_dir / "index.html"
    try:
        html = index_path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise ProjectError("index.html must be valid UTF-8.") from exc
    script_tag = f'<script src="./{RUNTIME_FILENAME}"></script>'
    if RUNTIME_FILENAME in html:
        raise ProjectError(f"index.html already references the reserved bridge filename {RUNTIME_FILENAME}.")
    head = re.search(r"<head\b[^>]*>", html, flags=re.IGNORECASE)
    root = re.search(r"<html\b[^>]*>", html, flags=re.IGNORECASE)
    doctype = re.search(r"<!doctype\s+html[^>]*>", html, flags=re.IGNORECASE)
    if head:
        position = head.end()
    elif root:
        position = root.end()
    elif doctype:
        position = doctype.end()
    else:
        position = 0
    html = f"{html[:position]}\n  {script_tag}\n{html[position:]}"
    index_path.write_text(html, encoding="utf-8", newline="")
    shutil.copyfile(runtime_api, project_dir / RUNTIME_FILENAME)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--runtime-api", required=True, type=Path)
    parser.add_argument("--name")
    parser.add_argument("--package-id")
    parser.add_argument("--version")
    parser.add_argument("--description")
    args = parser.parse_args()
    try:
        destination = args.destination.resolve()
        destination, file_count = safe_extract(args.archive.resolve(), destination)
        metadata = read_and_write_manifest(destination, args)
        inject_runtime(destination, args.runtime_api.resolve())
        print(f"Prepared {file_count} source files for {metadata['name']} ({metadata['packageId']} {metadata['version']}).")
        return 0
    except (ProjectError, OSError) as exc:
        print(f"Project validation failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
