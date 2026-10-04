#!/usr/bin/env python3
"""Copy a maintainer-selected ZIP only when it resolves inside the checked-out repository."""
import shutil
import sys
from pathlib import Path, PurePosixPath


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: copy_source_path.py <repository-relative.zip> <destination>", file=sys.stderr)
        return 2
    raw, destination = sys.argv[1], Path(sys.argv[2])
    relative = PurePosixPath(raw)
    if not raw or relative.is_absolute() or ".." in relative.parts or "\\" in raw or relative.suffix.lower() != ".zip":
        print("Source path must be a repository-relative ZIP without parent traversal.", file=sys.stderr)
        return 2
    root = Path.cwd().resolve()
    source = (root / Path(*relative.parts)).resolve()
    if not source.is_relative_to(root) or not source.is_file():
        print("Source ZIP was not found inside the checked-out repository.", file=sys.stderr)
        return 2
    shutil.copyfile(source, destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
