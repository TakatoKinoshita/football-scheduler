#!/usr/bin/env python3
"""Cloudflare Pagesへ配信するheaderへrelease IDを埋め込む。"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

_PLACEHOLDER = "__RELEASE_ID__"
_RELEASE_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}\Z")


def write_release_id(path: Path, release_id: str) -> None:
    if _RELEASE_PATTERN.fullmatch(release_id) is None:
        raise ValueError("release IDの形式が不正です。")
    content = path.read_text(encoding="utf-8")
    if content.count(_PLACEHOLDER) != 1:
        raise ValueError("release IDの置換位置が1個ではありません。")
    path.write_text(content.replace(_PLACEHOLDER, release_id), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument("release_id")
    args = parser.parse_args()
    write_release_id(args.path, args.release_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
