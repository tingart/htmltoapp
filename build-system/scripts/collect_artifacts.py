#!/usr/bin/env python3
"""Give Tauri bundle outputs stable names and produce SHA-256 checksums."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

EXTENSIONS = {
    "android": {".apk", ".aab"},
    "windows": {".msi", ".exe"},
    "linux": {".appimage", ".deb"},
    "macos": {".dmg"},
}


def slug(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip("-._")
    return value[:64] or "WebOS"


def is_android_release_bundle(path: Path, search_root: Path) -> bool:
    """Gradle names AAB directories `universalRelease`/`bundleRelease`, not just `release`."""
    directories = path.relative_to(search_root).parts[:-1]
    return any(part.casefold() == "release" or part.casefold().endswith("release") for part in directories)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", required=True, choices=sorted(EXTENSIONS))
    parser.add_argument("--name", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--search-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.output.exists():
            shutil.rmtree(args.output)
        args.output.mkdir(parents=True, exist_ok=True)
        candidates = [
            path for path in args.search_root.rglob("*")
            if path.is_file() and path.suffix.lower() in EXTENSIONS[args.platform]
            and (args.platform != "android" or is_android_release_bundle(path, args.search_root))
            and not (args.platform == "windows" and "uninstall" in path.name.lower())
        ]
        candidates.sort(key=lambda path: (path.suffix.lower(), path.as_posix()))
        if not candidates:
            raise RuntimeError(f"No expected {args.platform} bundles were found under {args.search_root}.")
        duplicate_extensions: dict[str, int] = {}
        for source in candidates:
            extension = source.suffix.lower()
            duplicate_extensions[extension] = duplicate_extensions.get(extension, 0) + 1
        artifacts = []
        base_name = slug(args.name)
        version = slug(args.version)
        for source in candidates:
            extension = source.suffix.lower()
            variant = ""
            if duplicate_extensions[extension] > 1:
                parent = source.parent.name
                arch = re.sub(r"[^A-Za-z0-9]+", "-", parent).strip("-")
                variant = f"-{arch}" if arch else ""
            filename = f"{base_name}-{version}-{args.platform}{variant}{extension}"
            destination = args.output / filename
            shutil.copy2(source, destination)
            checksum = hashlib.sha256()
            with destination.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    checksum.update(chunk)
            artifacts.append({"name": filename, "size": destination.stat().st_size, "sha256": checksum.hexdigest()})
            (args.output / f"{filename}.sha256").write_text(f"{checksum.hexdigest()}  {filename}\n", encoding="utf-8")
        manifest = {"appName": args.name, "version": args.version, "platform": args.platform, "artifacts": artifacts}
        (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        print(f"Collected {len(artifacts)} {args.platform} artifact(s) into {args.output}.")
        for artifact in artifacts:
            print(f"- {artifact['name']} ({artifact['size']} bytes, SHA-256 {artifact['sha256']})")
        return 0
    except (OSError, RuntimeError) as exc:
        print(f"Artifact collection failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
