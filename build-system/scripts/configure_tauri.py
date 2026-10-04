#!/usr/bin/env python3
"""Generate per-build Tauri v2 metadata without modifying the reusable shell."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from prepare_project import ProjectError, validate_metadata

BUNDLE_TARGETS = {
    "windows": ["msi", "nsis"],
    "linux": ["appimage", "deb"],
    "macos": ["dmg", "app"],
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--platform", required=True, choices=["android", "windows", "linux", "macos"])
    args = parser.parse_args()
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        metadata = validate_metadata(manifest.get("name"), manifest.get("packageId"), manifest.get("version"), manifest.get("description", ""))
        config = json.loads(args.config.read_text(encoding="utf-8"))
        config["productName"] = metadata["name"]
        config["version"] = metadata["version"]
        config["identifier"] = metadata["packageId"]
        config.setdefault("app", {}).setdefault("windows", [{}])[0]["title"] = metadata["name"]
        config.setdefault("bundle", {})["shortDescription"] = (metadata["description"] or metadata["name"])[:80]
        config["bundle"]["longDescription"] = metadata["description"] or f"{metadata['name']} — packaged with the HTML to App Tauri v2 build factory."
        if args.platform in BUNDLE_TARGETS:
            config["bundle"]["targets"] = BUNDLE_TARGETS[args.platform]
        # Android APK/AAB targets are selected explicitly by `tauri android build`.
        args.config.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"Configured Tauri v2 for {args.platform}: {metadata['name']} {metadata['version']} ({metadata['packageId']}).")
        return 0
    except (OSError, json.JSONDecodeError, ProjectError) as exc:
        print(f"Tauri configuration failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
