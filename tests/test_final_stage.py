from __future__ import annotations

import pytest

from football_scheduler.application import handle_request
from football_scheduler.final_stage import (
    FinalStageConfigurationError,
    validate_final_stage_input,
)


@pytest.mark.parametrize(
    ("team_count", "tournament_count", "block_count"),
    [(8, 2, 2), (16, 2, 8), (24, 3, 4), (32, 2, 16), (32, 4, 8)],
)
def test_accepts_every_supported_placement_tournament_configuration(
    team_count: int,
    tournament_count: int,
    block_count: int,
) -> None:
    validate_final_stage_input(
        {"format": "placement_tournament", "tournament_count": tournament_count},
        team_count=team_count,
        block_count=block_count,
    )


def test_accepts_custom_names_for_each_placement_tournament() -> None:
    validate_final_stage_input(
        {
            "format": "placement_tournament",
            "tournament_count": 2,
            "tournament_names": ["チャンピオンリーグ", "チャレンジリーグ"],
        },
        team_count=8,
        block_count=2,
    )


@pytest.mark.parametrize(
    "tournament_names",
    [["1つだけ"], ["上位", ""], ["上位", " 下位"]],
)
def test_rejects_invalid_placement_tournament_names(
    tournament_names: list[str],
) -> None:
    with pytest.raises(FinalStageConfigurationError) as error:
        validate_final_stage_input(
            {
                "format": "placement_tournament",
                "tournament_count": 2,
                "tournament_names": tournament_names,
            },
            team_count=8,
            block_count=2,
        )

    assert error.value.code == "PLACEMENT_TOURNAMENT_NAMES_INVALID"


@pytest.mark.parametrize(
    ("value", "team_count", "block_count", "code"),
    [
        (None, 8, 2, "FINAL_STAGE_FORMAT_REQUIRED"),
        (
            {"format": "placement_tournament", "tournament_count": 2},
            12,
            4,
            "PLACEMENT_TOURNAMENT_TEAM_COUNT_UNSUPPORTED",
        ),
        (
            {"format": "placement_tournament", "tournament_count": 4},
            16,
            4,
            "PLACEMENT_TOURNAMENT_COUNT_INVALID",
        ),
        (
            {"format": "placement_tournament", "tournament_count": 2},
            16,
            3,
            "PLACEMENT_TOURNAMENT_BLOCK_COUNT_INVALID",
        ),
        (
            {"format": "same_rank_league", "uneven_policy": "strict_same_rank"},
            3,
            2,
            "SAME_RANK_LEAGUE_TEAM_COUNT_UNSUPPORTED",
        ),
        (
            {"format": "same_rank_league"},
            18,
            4,
            "SAME_RANK_UNEVEN_POLICY_REQUIRED",
        ),
        (
            {"format": "same_rank_league", "uneven_policy": "merge_bottom"},
            16,
            4,
            "SAME_RANK_UNEVEN_POLICY_INVALID",
        ),
    ],
)
def test_rejects_invalid_configuration_with_stable_diagnostic(
    value: object,
    team_count: int,
    block_count: int,
    code: str,
) -> None:
    with pytest.raises(FinalStageConfigurationError) as error:
        validate_final_stage_input(value, team_count=team_count, block_count=block_count)

    assert error.value.code == code
    assert error.value.message


def test_schema_0_1_generation_request_is_rejected_before_parsing() -> None:
    result = handle_request(
        {
            "schema_version": "0.1.0",
            "request_kind": "day1_league",
            "teams": [],
        }
    )

    assert result["status"] == "error"
    assert result["diagnostics"][0]["code"] == "SCHEMA_VERSION_UNSUPPORTED"
    assert "編集用コピー" in result["diagnostics"][0]["message"]
