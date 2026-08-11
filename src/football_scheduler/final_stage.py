"""schema 0.2.0 の決勝方式入力と共通バリデーション。"""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum
from typing import Annotated, Any, Literal, Self

from pydantic import Field, model_validator

from football_scheduler.models import ContractModel, NonEmptyText


class FinalStageFormat(StrEnum):
    PLACEMENT_TOURNAMENT = "placement_tournament"
    SAME_RANK_LEAGUE = "same_rank_league"


class SameRankUnevenPolicy(StrEnum):
    STRICT_SAME_RANK = "strict_same_rank"
    MERGE_BOTTOM = "merge_bottom"


class PlacementTournamentFinalStage(ContractModel):
    format: Literal[FinalStageFormat.PLACEMENT_TOURNAMENT] = FinalStageFormat.PLACEMENT_TOURNAMENT
    tournament_count: int
    tournament_names: tuple[NonEmptyText, ...] = ()

    @model_validator(mode="after")
    def validate_tournament_names(self) -> Self:
        if self.tournament_names and len(self.tournament_names) != self.tournament_count:
            raise ValueError("トーナメント名はトーナメント数と同じ数だけ指定してください")
        if any(name.strip() != name or not name.strip() for name in self.tournament_names):
            raise ValueError("トーナメント名の前後に空白を含めず、1文字以上で指定してください")
        return self

    def resolved_tournament_names(self) -> tuple[str, ...]:
        if self.tournament_names:
            return self.tournament_names
        return tuple(
            f"第{index}順位決定トーナメント" for index in range(1, self.tournament_count + 1)
        )


class SameRankLeagueFinalStage(ContractModel):
    format: Literal[FinalStageFormat.SAME_RANK_LEAGUE] = FinalStageFormat.SAME_RANK_LEAGUE
    uneven_policy: SameRankUnevenPolicy | None = None


FinalStageConfig = Annotated[
    PlacementTournamentFinalStage | SameRankLeagueFinalStage,
    Field(discriminator="format"),
]


class FinalStageConfigurationError(ValueError):
    """利用者が入力を直せる決勝方式設定エラー。"""

    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


_PLACEMENT_BLOCK_COUNTS: dict[tuple[int, int], frozenset[int]] = {
    (8, 2): frozenset({2, 4}),
    (16, 2): frozenset({2, 4, 8}),
    (24, 3): frozenset({2, 4, 8}),
    (32, 2): frozenset({2, 4, 8, 16}),
    (32, 4): frozenset({2, 4, 8}),
}


def validate_final_stage_input(
    value: object,
    *,
    team_count: int | None,
    block_count: int | None,
) -> None:
    """生のAPI入力を検証し、仕様で固定した診断コードを返せるようにする。"""

    if not isinstance(value, Mapping) or not value.get("format"):
        raise FinalStageConfigurationError(
            "FINAL_STAGE_FORMAT_REQUIRED",
            "1日目の日程を作成する前に、決勝方式を選択してください。",
        )

    final_format = value.get("format")
    if final_format == FinalStageFormat.PLACEMENT_TOURNAMENT:
        _validate_placement_tournament(value, team_count=team_count, block_count=block_count)
        return
    if final_format == FinalStageFormat.SAME_RANK_LEAGUE:
        _validate_same_rank_league(value, team_count=team_count, block_count=block_count)
        return
    raise FinalStageConfigurationError(
        "FINAL_STAGE_FORMAT_REQUIRED",
        "決勝方式を読み取れませんでした。画面から決勝方式を選び直してください。",
        format=str(final_format),
    )


def _validate_placement_tournament(
    value: Mapping[object, object],
    *,
    team_count: int | None,
    block_count: int | None,
) -> None:
    if team_count not in {8, 16, 24, 32}:
        raise FinalStageConfigurationError(
            "PLACEMENT_TOURNAMENT_TEAM_COUNT_UNSUPPORTED",
            "順位決定トーナメントは8・16・24・32チームの大会で選択してください。",
            team_count=team_count if team_count is not None else 0,
        )
    tournament_count = value.get("tournament_count")
    allowed_counts = sorted(
        count for total, count in _PLACEMENT_BLOCK_COUNTS if total == team_count
    )
    if (
        not isinstance(tournament_count, int)
        or isinstance(tournament_count, bool)
        or tournament_count not in allowed_counts
    ):
        raise FinalStageConfigurationError(
            "PLACEMENT_TOURNAMENT_COUNT_INVALID",
            "参加チーム数に対応するトーナメント数を選択してください。",
            team_count=team_count,
            tournament_count=tournament_count if isinstance(tournament_count, int) else 0,
            allowed_tournament_counts=allowed_counts,
        )
    tournament_names = value.get("tournament_names")
    if tournament_names is not None and (
        not isinstance(tournament_names, (list, tuple))
        or (
            len(tournament_names) > 0
            and (
                len(tournament_names) != tournament_count
                or any(
                    not isinstance(name, str) or name.strip() != name or not name or len(name) > 200
                    for name in tournament_names
                )
            )
        )
    ):
        raise FinalStageConfigurationError(
            "PLACEMENT_TOURNAMENT_NAMES_INVALID",
            "各トーナメントの名前を1文字以上200文字以内で入力してください。",
            tournament_count=tournament_count,
        )
    allowed_blocks = sorted(_PLACEMENT_BLOCK_COUNTS[(team_count, tournament_count)])
    if block_count not in allowed_blocks:
        raise FinalStageConfigurationError(
            "PLACEMENT_TOURNAMENT_BLOCK_COUNT_INVALID",
            "選択したトーナメント構成に対応するブロック数を選択してください。",
            team_count=team_count,
            tournament_count=tournament_count,
            block_count=block_count if block_count is not None else 0,
            allowed_block_counts=allowed_blocks,
        )


def _validate_same_rank_league(
    value: Mapping[object, object],
    *,
    team_count: int | None,
    block_count: int | None,
) -> None:
    if (
        team_count is None
        or block_count is None
        or not 4 <= team_count <= 32
        or not 2 <= block_count <= team_count // 2
    ):
        raise FinalStageConfigurationError(
            "SAME_RANK_LEAGUE_TEAM_COUNT_UNSUPPORTED",
            "同順位リーグは4〜32チームで、各ブロックが2チーム以上になるブロック数を選択してください。",
            team_count=team_count if team_count is not None else 0,
            block_count=block_count if block_count is not None else 0,
        )
    uneven_policy = value.get("uneven_policy")
    if team_count % block_count != 0 and uneven_policy is None:
        raise FinalStageConfigurationError(
            "SAME_RANK_UNEVEN_POLICY_REQUIRED",
            "ブロック人数が均等でないため、最下位側のまとめ方を選択してください。",
            team_count=team_count,
            block_count=block_count,
        )
    allowed = {item.value for item in SameRankUnevenPolicy}
    if uneven_policy not in allowed:
        raise FinalStageConfigurationError(
            "SAME_RANK_UNEVEN_POLICY_INVALID",
            "端数処理の選択を読み取れませんでした。画面から選び直してください。",
            uneven_policy=str(uneven_policy),
        )
    if team_count % block_count == 0 and uneven_policy != SameRankUnevenPolicy.STRICT_SAME_RANK:
        raise FinalStageConfigurationError(
            "SAME_RANK_UNEVEN_POLICY_INVALID",
            "ブロック人数が均等な大会では、厳密な同順位方式を使用してください。",
            uneven_policy=str(uneven_policy),
        )
