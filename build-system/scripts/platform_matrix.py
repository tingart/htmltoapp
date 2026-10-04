#!/usr/bin/env python3
"""Validate the requested platforms and emit a GitHub Actions matrix."""
import json
import sys

RUNNERS = {
    "android": "ubuntu-24.04",
    "linux": "ubuntu-24.04",
    "windows": "windows-2025",
    "macos": "macos-15",
}


def main() -> int:
    requested = [part.strip().lower() for part in sys.argv[1].split(",") if part.strip()]
    if requested == ["all"]:
        requested = list(RUNNERS)
    if not requested or any(platform not in RUNNERS for platform in requested):
        print("Platforms must be a comma-separated list of android, windows, linux, macos, or all.", file=sys.stderr)
        return 2
    unique = list(dict.fromkeys(requested))
    matrix = [{"platform": platform, "runner": RUNNERS[platform]} for platform in unique]
    print(json.dumps(matrix, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
