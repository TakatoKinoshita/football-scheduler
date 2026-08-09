"""ローカルのトーナメント表比較用fixtureを本番生成器から書き出す。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from football_scheduler.league import generate_league_plan
from football_scheduler.league_results import LeagueStandings, Standing
from football_scheduler.tournament import generate_tournament_plan

PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIRECTORY = PROJECT_ROOT / "web" / "src" / "fixtures" / "tournament-bracket-preview"
RANDOM_SEED = 20260803
TEAM_NAMES = (
    "青空",
    "あおぞら中央",
    "アオゾラ中央",
    "AOZORA",
    "みどり",
    "美土里",
    "HIGASHINO",
    "ミドリ",
    "KITAURA",
    "北浦",
    "きたうら",
    "キタウラ",
    "SHIRAKAWA",
    "白川",
    "しらかわ",
    "シラカワ",
)

FIXTURE_METADATA = {
    7: (
        "upper-7-seeded",
        "7チーム上位トーナメント・上位シードの予備戦免除あり",
    ),
    8: (
        "upper-8",
        "8チーム上位トーナメント・完全順位決定",
    ),
    9: (
        "upper-9-seeded",
        "9チーム上位トーナメント・8チームの負け下がりあり",
    ),
    16: (
        "upper-16",
        "16チーム上位トーナメント・完全順位決定",
    ),
}


def _fixture(participant_count: int) -> dict[str, Any]:
    teams = [
        {"id": f"team-{index:02d}", "name": TEAM_NAMES[index - 1]}
        for index in range(1, participant_count + 1)
    ]
    blocks = [
        {"id": chr(ord("A") + index), "team_ids": [team["id"]]} for index, team in enumerate(teams)
    ]
    league_plan = generate_league_plan(
        {
            "teams": teams,
            "block_count": participant_count,
            "assignment_mode": "manual",
            "manual_blocks": blocks,
            "random_seed": RANDOM_SEED,
        }
    )
    standings = LeagueStandings(
        standings=tuple(
            Standing(
                block_id=block.id,
                rank=1,
                team_id=block.team_ids[0],
                played=0,
                wins=0,
                draws=0,
                losses=0,
                goals_for=0,
                goals_against=0,
                goal_difference=0,
                points=0,
                tie_break="プレビュー用固定順位",
            )
            for block in league_plan.blocks
        ),
        draws=(),
    )
    plan = generate_tournament_plan(
        {
            "request_kind": "tournament_plan",
            "league_plan": league_plan.model_dump(mode="json"),
            "league_standings": standings.model_dump(mode="json"),
            "final_stage": {"format": "placement_tournament", "tournament_count": 2},
            "random_seed": RANDOM_SEED,
        }
    )
    upper = plan.upper
    seed_by_entry = {(seed.entry.block_id, seed.entry.rank): seed for seed in upper.seeds}
    opening_byes: list[dict[str, Any]] = []
    for bye in upper.byes:
        entry = bye.entry
        if entry.type != "league_rank":
            continue
        seed = seed_by_entry[(entry.block_id, entry.rank)]
        opening_byes.append(
            {
                "seed_no": seed.seed_no,
                "team_id": seed.team_id,
                "entry": entry.model_dump(mode="json"),
                "next_match_id": bye.next_match_id,
            }
        )
    preliminary_ids = [
        match.id
        for match in upper.matches
        if match.round == "予備戦" and match.rank_range == (1, participant_count)
    ]
    fixture_id, description = FIXTURE_METADATA[participant_count]
    return {
        "fixture_id": fixture_id,
        "description": description,
        "teams": teams,
        "tournament_plan": plan.model_dump(mode="json"),
        "expected": {
            "upper_participant_count": participant_count,
            "upper_match_count": len(upper.matches),
            "upper_bye_count": len(upper.byes),
            "lower_participant_count": plan.lower.participant_count,
            "opening_preliminary_match_ids": preliminary_ids,
            "opening_byes": opening_byes,
        },
    }


def _serialized_fixture(participant_count: int) -> str:
    return json.dumps(_fixture(participant_count), ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fixtureを書き換えず、本番生成器から再生成した内容と一致するか確認する",
    )
    args = parser.parse_args()
    stale: list[Path] = []
    for participant_count in (16, 9, 8, 7):
        fixture_id, _ = FIXTURE_METADATA[participant_count]
        path = OUTPUT_DIRECTORY / f"{fixture_id}.json"
        content = _serialized_fixture(participant_count)
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != content:
                stale.append(path)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        print(path.relative_to(PROJECT_ROOT))
    if stale:
        for path in stale:
            print(f"fixtureが最新ではありません: {path.relative_to(PROJECT_ROOT)}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
