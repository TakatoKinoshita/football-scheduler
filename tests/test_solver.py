from __future__ import annotations

from collections import Counter, defaultdict
from itertools import pairwise

from football_scheduler.fixtures import make_representative_request, make_smoke_request
from football_scheduler.models import (
    DaySettings,
    MatchSpec,
    RefereeKind,
    ScheduleRequest,
    SolverStatus,
)
from football_scheduler.solver import solve_schedule


def test_smoke_fixture_is_optimal_and_json_serializable() -> None:
    request = make_smoke_request()

    result = solve_schedule(request)

    assert result.status is SolverStatus.OPTIMAL
    assert result.metrics.used_sections == 1
    assert result.metrics.optimality_proven is True
    assert result.metrics.num_search_workers == 1
    assert len([slot for slot in result.slots if slot.match_id is not None]) == 2
    assert all(
        slot.referee_assignment is not None
        and slot.referee_assignment.kind is RefereeKind.ORGANIZER
        for slot in result.slots
        if slot.match_id is not None
    )
    assert result.model_dump(mode="json")["status"] == "OPTIMAL"


def test_representative_fixture_satisfies_core_hard_constraints() -> None:
    request = make_representative_request()

    result = solve_schedule(request)

    assert result.status in {SolverStatus.OPTIMAL, SolverStatus.FEASIBLE}
    assert result.metrics.used_sections is not None
    scheduled_slots = [slot for slot in result.slots if slot.match_id is not None]
    assert Counter(slot.match_id for slot in scheduled_slots) == Counter(
        match.id for match in request.matches
    )

    possible_teams = {match.id: match.possible_team_ids for match in request.matches}
    roles_by_section: dict[int, list[str]] = defaultdict(list)
    matches_by_team: dict[str, list[int]] = defaultdict(list)
    organizer_count: Counter[int] = Counter()
    for slot in scheduled_slots:
        assert slot.match_id is not None
        assert slot.referee_assignment is not None
        roles_by_section[slot.section_no].extend(possible_teams[slot.match_id])
        for team_id in possible_teams[slot.match_id]:
            matches_by_team[team_id].append(slot.section_no)
        if slot.referee_assignment.kind is RefereeKind.TEAM:
            assert slot.referee_assignment.team_id is not None
            roles_by_section[slot.section_no].append(slot.referee_assignment.team_id)
            assert slot.section_no != 1
        else:
            organizer_count[slot.section_no] += 1

    for roles in roles_by_section.values():
        assert len(roles) == len(set(roles))
    for sections in matches_by_team.values():
        ordered = sorted(sections)
        assert all(right - left >= 2 for left, right in pairwise(ordered))
    assert all(count <= request.referees.organizer_capacity for count in organizer_count.values())
    assert all(
        slot.referee_assignment is not None
        and slot.referee_assignment.kind is RefereeKind.ORGANIZER
        for slot in scheduled_slots
        if slot.section_no == 1
    )


def test_same_seed_produces_same_schedule() -> None:
    request = make_representative_request()

    first = solve_schedule(request)
    second = solve_schedule(request)

    assert first.status == second.status
    assert first.slots == second.slots
    assert first.metrics.used_sections == second.metrics.used_sections


def test_possible_team_sets_and_dependency_require_two_section_gap() -> None:
    base = make_smoke_request()
    request = ScheduleRequest(
        teams=base.teams,
        courts=(base.courts[0],),
        matches=(
            base.matches[0],
            MatchSpec(
                id="UT-FINAL",
                phase="upper_tournament",
                round="決勝",
                possible_home_team_ids=(base.teams[0].id, base.teams[1].id),
                possible_away_team_ids=(base.teams[2].id,),
                prerequisite_match_ids=(base.matches[0].id,),
                organizer_referee_required=True,
            ),
        ),
        day=DaySettings(max_sections=4),
        referees=base.referees,
        random_seed=base.random_seed,
        solver=base.solver,
    )

    result = solve_schedule(request)

    assert result.status is SolverStatus.OPTIMAL
    section_by_match = {slot.match_id: slot.section_no for slot in result.slots if slot.match_id}
    assert section_by_match["UT-FINAL"] >= section_by_match["LG-A-M1"] + 2


def test_dependency_can_reference_a_match_declared_later() -> None:
    base = make_smoke_request()
    final = MatchSpec(
        id="UT-FINAL",
        phase="upper_tournament",
        round="決勝",
        possible_home_team_ids=(base.teams[0].id,),
        possible_away_team_ids=(base.teams[2].id,),
        prerequisite_match_ids=(base.matches[0].id,),
        organizer_referee_required=True,
    )
    request = ScheduleRequest(
        teams=base.teams,
        courts=(base.courts[0],),
        matches=(final, base.matches[0]),
        day=DaySettings(max_sections=4),
        referees=base.referees,
        random_seed=base.random_seed,
        solver=base.solver,
    )

    result = solve_schedule(request)

    assert result.status is SolverStatus.OPTIMAL
    section_by_match = {slot.match_id: slot.section_no for slot in result.slots if slot.match_id}
    assert section_by_match["UT-FINAL"] >= section_by_match["LG-A-M1"] + 2


def test_dependency_cycle_is_reported_without_running_the_solver() -> None:
    base = make_smoke_request()
    first = base.matches[0].model_copy(update={"prerequisite_match_ids": (base.matches[1].id,)})
    second = base.matches[1].model_copy(update={"prerequisite_match_ids": (base.matches[0].id,)})
    request = base.model_copy(update={"matches": (first, second)})

    result = solve_schedule(request)

    assert result.status is SolverStatus.INFEASIBLE
    assert result.diagnostics[0].code == "TOURNAMENT_DEPENDENCY_CYCLE"
    assert result.diagnostics[0].details["match_ids"] == ["LG-A-M1", "LG-A-M2", "LG-A-M1"]


def test_insufficient_slots_is_reported_as_infeasible() -> None:
    base = make_smoke_request()
    request = base.model_copy(
        update={"day": DaySettings(max_sections=1), "courts": (base.courts[0],)}
    )

    result = solve_schedule(request)

    assert result.status is SolverStatus.INFEASIBLE
    assert result.slots == ()
    assert result.metrics.optimality_proven is True
    assert result.diagnostics[0].code == "INSUFFICIENT_SLOTS"


def test_search_timeout_is_reported_as_unknown() -> None:
    base = make_representative_request()
    request = base.model_copy(
        update={"solver": base.solver.model_copy(update={"max_time_seconds": 0.000001})}
    )

    result = solve_schedule(request)

    assert result.status is SolverStatus.UNKNOWN
    assert result.metrics.optimality_proven is False
    assert result.diagnostics[0].code == "SCHEDULE_SEARCH_TIMEOUT"
