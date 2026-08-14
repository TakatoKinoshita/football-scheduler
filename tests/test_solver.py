from __future__ import annotations

from collections import Counter, defaultdict
from itertools import pairwise

import pytest
from ortools.sat.python import cp_model

from football_scheduler import solver as solver_module
from football_scheduler.fixtures import (
    make_maximum_mvp_request,
    make_representative_request,
    make_smoke_request,
)
from football_scheduler.models import (
    Court,
    DaySettings,
    MatchSpec,
    RefereeKind,
    RefereeSettings,
    ScheduleRequest,
    SolverSettings,
    SolverStatus,
    Team,
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
    assert [item.count for item in result.metrics.league_team_referee_counts] == [0, 0, 0, 0]
    assert result.metrics.league_team_referee_count_min == 0
    assert result.metrics.league_team_referee_count_max == 0
    assert result.metrics.league_team_referee_count_difference == 0
    assert result.model_dump(mode="json")["status"] == "OPTIMAL"


def test_referee_counts_are_serialized_in_team_id_order() -> None:
    base = make_smoke_request()
    request = base.model_copy(update={"teams": tuple(reversed(base.teams))})

    result = solve_schedule(request)

    assert [item.team_id for item in result.metrics.league_team_referee_counts] == sorted(
        team.id for team in base.teams
    )


def test_maximum_mvp_fixture_uses_documented_input_limits() -> None:
    request = make_maximum_mvp_request()

    assert len(request.teams) == 32
    assert len(request.courts) == 4
    assert len(request.matches) == 48
    assert request.day.max_sections == 24
    assert request.solver.max_time_seconds == 20


def _court_movement_request(*, unavoidable: bool) -> ScheduleRequest:
    teams = tuple(Team(id=f"team-{index}", name=f"チーム{index}") for index in range(1, 7))
    matches = (
        MatchSpec(
            id="UT-SOURCE-A",
            phase="upper_tournament",
            possible_home_team_ids=("team-1",),
            possible_away_team_ids=("team-2",),
            organizer_referee_required=True,
        ),
        MatchSpec(
            id="UT-SOURCE-B",
            phase="upper_tournament",
            possible_home_team_ids=("team-3",),
            possible_away_team_ids=("team-4",),
            organizer_referee_required=True,
        ),
        MatchSpec(
            id="UT-MIDDLE",
            phase="upper_tournament",
            possible_home_team_ids=("team-5",),
            possible_away_team_ids=("team-6",),
            organizer_referee_required=True,
        ),
        MatchSpec(
            id="UT-FINAL",
            phase="upper_tournament",
            possible_home_team_ids=("team-1",),
            possible_away_team_ids=(("team-3",) if unavoidable else ("team-2",)),
            prerequisite_match_ids=(
                ("UT-SOURCE-A", "UT-SOURCE-B") if unavoidable else ("UT-SOURCE-A",)
            ),
            organizer_referee_required=True,
        ),
    )
    return ScheduleRequest(
        teams=teams,
        courts=(Court(id="court-1", name="1コート"), Court(id="court-2", name="2コート")),
        matches=matches,
        day=DaySettings(max_sections=4),
        referees=RefereeSettings(organizer_capacity=2),
        solver=SolverSettings(max_time_seconds=10),
    )


def test_total_court_movement_keeps_consecutive_assignments_on_the_same_court() -> None:
    result = solve_schedule(_court_movement_request(unavoidable=False))
    by_match = {slot.match_id: slot for slot in result.slots if slot.match_id is not None}

    assert result.status is SolverStatus.OPTIMAL
    assert by_match["UT-SOURCE-A"].court_id == by_match["UT-FINAL"].court_id
    assert result.metrics.team_court_change_count == 0
    assert "team_court_change_count" in result.metrics.optimized_objectives


def test_total_court_movement_returns_the_minimum_when_one_move_is_unavoidable() -> None:
    result = solve_schedule(_court_movement_request(unavoidable=True))

    assert result.status is SolverStatus.OPTIMAL
    assert result.metrics.team_court_change_count == 1
    assert "team_court_change_count" in result.metrics.optimized_objectives


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
    assignments_by_team: dict[str, list[tuple[int, str, str]]] = defaultdict(list)
    slots_by_position = {(slot.section_no, slot.court_id): slot for slot in scheduled_slots}
    organizer_count: Counter[int] = Counter()
    for slot in scheduled_slots:
        assert slot.match_id is not None
        assert slot.referee_assignment is not None
        roles_by_section[slot.section_no].extend(possible_teams[slot.match_id])
        for team_id in possible_teams[slot.match_id]:
            matches_by_team[team_id].append(slot.section_no)
            assignments_by_team[team_id].append((slot.section_no, slot.court_id, "match"))
        if slot.referee_assignment.kind is RefereeKind.TEAM:
            assert slot.referee_assignment.team_id is not None
            roles_by_section[slot.section_no].append(slot.referee_assignment.team_id)
            assignments_by_team[slot.referee_assignment.team_id].append(
                (slot.section_no, slot.court_id, "referee")
            )
            assert slot.section_no != 1
            previous = slots_by_position[slot.section_no - 1, slot.court_id]
            assert previous.match_id is not None
            assert slot.referee_assignment.team_id in possible_teams[previous.match_id]
        else:
            organizer_count[slot.section_no] += 1

    for roles in roles_by_section.values():
        assert len(roles) == len(set(roles))
    for sections in matches_by_team.values():
        ordered = sorted(sections)
        assert all(right - left >= 2 for left, right in pairwise(ordered))
    for assignments in assignments_by_team.values():
        for left, right in pairwise(sorted(assignments)):
            if right[0] == left[0] + 1:
                assert right[1] == left[1]
                assert (left[2], right[2]) == ("match", "referee")
    assert all(count <= request.referees.organizer_capacity for count in organizer_count.values())
    assert all(
        slot.referee_assignment is not None
        and slot.referee_assignment.kind is RefereeKind.ORGANIZER
        for slot in scheduled_slots
        if slot.section_no == 1
    )
    referee_counts = {
        item.team_id: item.count for item in result.metrics.league_team_referee_counts
    }
    assert result.metrics.used_sections == 10
    assert sum(referee_counts.values()) == 21
    assert result.metrics.league_previous_same_court_referee_count == 21
    assert result.metrics.referee_then_match_count == 0
    assert result.metrics.adjacent_assignment_court_change_count == 0
    assert "adjacent_assignment_court_change_count" not in result.metrics.optimized_objectives
    assert "adjacent_assignment_court_change_count" not in {
        stage.objective for stage in result.metrics.objective_stages
    }
    assert "referee_then_match_count" not in {
        stage.objective for stage in result.metrics.objective_stages
    }
    assert "league_previous_same_court_referee_count" not in {
        stage.objective for stage in result.metrics.objective_stages
    }


def _transition_model_status(
    first_role: str,
    second_role: str,
    *,
    second_section: int = 1,
    second_court: int = 1,
) -> cp_model.CpSolverStatus:
    model = cp_model.CpModel()
    horizon = 3
    placement: dict[tuple[int, int, int], cp_model.IntVar] = {}
    match_in_section: dict[tuple[int, int], cp_model.IntVar] = {}
    fixed_positions = ((0, 0), (second_section, second_court))
    for match_index, fixed_position in enumerate(fixed_positions):
        for section in range(horizon):
            in_section = model.new_bool_var(f"match_{match_index}_{section}")
            match_in_section[match_index, section] = in_section
            court_variables = []
            for court in range(2):
                variable = model.new_bool_var(f"placement_{match_index}_{section}_{court}")
                placement[match_index, section, court] = variable
                court_variables.append(variable)
                model.add(variable == int(fixed_position == (section, court)))
            model.add(sum(court_variables) == in_section)

    possible_matches = {
        "focus": tuple(
            match_index
            for match_index, role in enumerate((first_role, second_role))
            if role == "match"
        )
    }
    team_referee: dict[tuple[int, int, str], cp_model.IntVar] = {}
    for match_index, (role, (section, _court)) in enumerate(
        zip((first_role, second_role), fixed_positions, strict=True)
    ):
        if role != "referee":
            continue
        variable = model.new_bool_var(f"referee_{match_index}_{section}")
        model.add(variable == 1)
        team_referee[match_index, section, "focus"] = variable

    role_any, _role_on_court, role_court, _match_court = solver_module._add_team_role_court_state(
        model,
        placement,
        match_in_section,
        team_referee,
        possible_matches,
        horizon,
        2,
    )
    solver_module._add_adjacent_assignment_same_court_constraints(
        model,
        role_any,
        role_court,
        ("focus",),
        horizon,
    )
    return cp_model.CpSolver().solve(model)


@pytest.mark.parametrize(
    ("first_role", "second_role"),
    [("match", "referee"), ("referee", "match"), ("referee", "referee")],
)
def test_adjacent_day1_roles_cannot_change_courts(
    first_role: str,
    second_role: str,
) -> None:
    assert _transition_model_status(first_role, second_role) == cp_model.INFEASIBLE
    assert _transition_model_status(first_role, second_role, second_court=0) == cp_model.OPTIMAL


def test_day1_court_change_is_allowed_after_an_empty_section() -> None:
    assert (
        _transition_model_status(
            "match",
            "referee",
            second_section=2,
            second_court=1,
        )
        == cp_model.OPTIMAL
    )


def test_same_seed_produces_same_schedule() -> None:
    request = make_representative_request()

    first = solve_schedule(request)
    second = solve_schedule(request)

    assert first.status == second.status
    assert first.slots == second.slots
    assert first.metrics.used_sections == second.metrics.used_sections
    assert first.metrics.league_team_referee_counts == second.metrics.league_team_referee_counts
    assert (
        first.metrics.league_team_referee_count_difference
        == second.metrics.league_team_referee_count_difference
    )


def test_league_without_a_safe_previous_match_referee_is_infeasible() -> None:
    base = make_smoke_request()
    repeated_matches = tuple(
        MatchSpec(
            id=f"LG-A-M{index}",
            phase="league",
            round="Aブロック",
            possible_home_team_ids=(base.teams[0].id, base.teams[1].id),
            possible_away_team_ids=(base.teams[2].id,),
        )
        for index in range(1, 4)
    )
    request = ScheduleRequest(
        teams=base.teams,
        courts=(base.courts[0],),
        matches=repeated_matches,
        day=DaySettings(max_sections=5),
        referees=base.referees,
        random_seed=base.random_seed,
        solver=base.solver,
    )

    result = solve_schedule(request)

    assert result.status is SolverStatus.INFEASIBLE
    assert result.slots == ()
    assert result.diagnostics[0].code == "LEAGUE_REFEREE_UNAVAILABLE"


def test_schedule_without_league_matches_reports_zero_league_referee_counts() -> None:
    base = make_smoke_request()
    tournament_match = base.matches[0].model_copy(
        update={"id": "UT-FINAL", "phase": "upper_tournament", "round": "決勝"}
    )
    request = base.model_copy(update={"matches": (tournament_match,)})

    result = solve_schedule(request)

    assert result.status is SolverStatus.OPTIMAL
    assert [item.count for item in result.metrics.league_team_referee_counts] == [0, 0, 0, 0]
    assert result.metrics.league_team_referee_count_difference == 0


def test_organizer_only_league_reports_zero_team_referee_counts() -> None:
    base = make_smoke_request()
    request = base.model_copy(
        update={
            "courts": (base.courts[0],),
            "matches": tuple(
                match.model_copy(update={"organizer_referee_required": True})
                for match in base.matches
            ),
        }
    )

    result = solve_schedule(request)

    assert result.status is SolverStatus.OPTIMAL
    assert [item.count for item in result.metrics.league_team_referee_counts] == [0, 0, 0, 0]
    assert result.metrics.league_team_referee_count_difference == 0


def test_feasible_fairness_solution_keeps_referee_audit_metrics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    teams = tuple(Team(id=f"team-{index}", name=f"チーム{index}") for index in range(1, 9))
    request = ScheduleRequest(
        teams=teams,
        courts=(Court(id="court-a", name="Aコート"), Court(id="court-b", name="Bコート")),
        matches=tuple(
            MatchSpec(
                id=f"LG-M{index + 1}",
                phase="league",
                possible_home_team_ids=(teams[index * 2].id,),
                possible_away_team_ids=(teams[index * 2 + 1].id,),
            )
            for index in range(4)
        ),
        day=DaySettings(max_sections=2),
        referees=RefereeSettings(organizer_capacity=2),
        random_seed=20260803,
        solver=SolverSettings(max_time_seconds=10),
    )
    original_configured_solver = solver_module._configured_solver
    call_count = 0

    def stop_fairness_after_first_solution(max_time_seconds: float, random_seed: int) -> object:
        nonlocal call_count
        call_count += 1
        configured = original_configured_solver(max_time_seconds, random_seed)
        # 主目的探索に続く公平性探索だけを打ち切る。
        if call_count == 2:
            configured.parameters.max_time_in_seconds = 0.000001
        return configured

    monkeypatch.setattr(solver_module, "_configured_solver", stop_fairness_after_first_solution)

    result = solver_module.solve_schedule(request)

    assert result.status is SolverStatus.FEASIBLE
    assert result.metrics.optimality_proven is False
    assert len(result.metrics.league_team_referee_counts) == 8
    assert result.metrics.league_team_referee_count_difference is not None


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
                organizer_referee_required=False,
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
    tournament_slot = next(slot for slot in result.slots if slot.match_id == "UT-FINAL")
    assert tournament_slot.referee_assignment is not None
    assert tournament_slot.referee_assignment.kind is RefereeKind.TEAM
    assert [item.count for item in result.metrics.league_team_referee_counts] == [0, 0, 0, 0]
    assert result.metrics.league_team_referee_count_difference == 0


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
