from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

_MODEL_DIGEST_SCRIPT = r"""
from hashlib import sha256
from tests.test_day2_schedule import _request
from football_scheduler.day2_schedule import _build_cp_model, _build_path_model

request, _plan = _request(
    team_count=32,
    block_count=8,
    tournament_count=2,
    court_count=4,
    organizer_capacity=4,
    max_sections=17,
    max_time_seconds=1,
)
path_model = _build_path_model(request.tournament_plan)
model, _variables = _build_cp_model(request, path_model, 17)
print(sha256(str(model.proto).encode()).hexdigest())
"""


def _model_digest(hash_seed: str) -> str:
    environment = os.environ.copy()
    environment["PYTHONHASHSEED"] = hash_seed
    result = subprocess.run(
        [sys.executable, "-c", _MODEL_DIGEST_SCRIPT],
        cwd=Path(__file__).parents[1],
        env=environment,
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return result.stdout.strip()


def test_cp_sat_model_is_stable_across_hash_seeds() -> None:
    assert _model_digest("1") == _model_digest("987654321")
