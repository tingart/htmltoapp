#!/usr/bin/env python3
"""Perform a small preflight check before passing project artwork to Tauri's icon tool."""
import struct
import sys
from pathlib import Path

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_ICON_BYTES = 10 * 1024 * 1024


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: validate_icon.py <icon.png>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    try:
        size = path.stat().st_size
        if size < 33 or size > MAX_ICON_BYTES:
            raise ValueError("PNG icon must be between 33 bytes and 10 MiB.")
        with path.open("rb") as stream:
            header = stream.read(24)
        if header[:8] != PNG_SIGNATURE or header[12:16] != b"IHDR":
            raise ValueError("icon.png must be a real PNG image.")
        width, height = struct.unpack(">II", header[16:24])
        if width != height or width < 32 or width > 4096:
            raise ValueError("icon.png must be square and between 32 × 32 and 4096 × 4096 pixels.")
        print(f"Validated square PNG icon: {width} × {height}.")
        return 0
    except (OSError, ValueError) as error:
        print(f"Invalid app icon: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
