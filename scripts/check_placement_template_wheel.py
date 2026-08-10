#!/usr/bin/env python3
"""wheelから順位決定トーナメント日程テンプレートを実際に読み込む。"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="wheelに同梱した日程テンプレートの読込みと完全性を検証します。"
    )
    parser.add_argument("wheel", type=Path, help="検証するwheel、またはwheelを1件含むdirectory")
    return parser


def _resolve_wheel(value: Path) -> Path:
    if value.is_file() and value.suffix == ".whl":
        return value.resolve()
    if value.is_dir():
        wheels = sorted(value.glob("*.whl"))
        if len(wheels) == 1:
            return wheels[0].resolve()
        raise ValueError(f"directory内のwheelは1件である必要があります: {len(wheels)}件")
    raise ValueError("wheelファイルまたはwheelを含むdirectoryを指定してください。")


def main() -> int:
    args = _parser().parse_args()
    try:
        wheel = _resolve_wheel(args.wheel)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    runner = """
import sys
sys.path.insert(0, sys.argv[1])
from football_scheduler.placement_template_runtime import load_placement_template_catalog
catalog = load_placement_template_catalog()
if len(catalog.entries_by_id) != 1360:
    raise SystemExit(f"catalog entry count mismatch: {len(catalog.entries_by_id)}")
print(f"wheel catalog loaded: {len(catalog.entries_by_id)} entries")
"""
    completed = subprocess.run(
        [sys.executable, "-I", "-c", runner, str(wheel)],
        cwd=wheel.parent,
        check=False,
        text=True,
    )
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
