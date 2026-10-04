#!/usr/bin/env python3
"""Ensure a manual build path points to a ZIP inside the checked-out repository."""
import sys
from pathlib import Path, PurePosixPath


def main() -> int:
    if len(sys.argv) != 2:
        print("Provide a repository-relative .zip path.", file=sys.stderr)
        return 2
    raw = sys.argv[1]
    path = PurePosixPath(raw)
    if not raw or path.is_absolute() or ".." in path.parts or "\\" in raw or path.suffix.lower() != ".zip":
        print("Source path must be a repository-relative ZIP without parent traversal.", file=sys.stderr)
        return 2
    root = Path.cwd().resolve()
    candidate = (root / Path(*path.parts)).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        print("Source ZIP was not found inside the checked-out repository.", file=sys.stderr)
        return 2
    print(candidate)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
