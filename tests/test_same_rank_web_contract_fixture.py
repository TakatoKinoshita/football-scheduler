from __future__ import annotations

from scripts.write_same_rank_web_contract_fixture import OUTPUT_PATH, serialized_fixture


def test_same_rank_web_contract_fixture_matches_python_generator() -> None:
    assert OUTPUT_PATH.read_text(encoding="utf-8") == serialized_fixture()
