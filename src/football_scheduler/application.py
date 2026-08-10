"""FaaS から独立したスケジュール生成のアプリケーション境界。

トランスポート固有のイベント形式は扱わず、JSON 互換の辞書を受け取って
JSON 互換の辞書を返す。入力上限とソルバー実行時間の上限もこの境界で
一貫して適用する。
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Mapping, Sequence
from copy import deepcopy
from time import monotonic
from typing import Any

from pydantic import ValidationError

from football_scheduler.day1_league import prepare_day1_league_schedule
from football_scheduler.day2_creation import Day2CreationRequest
from football_scheduler.day2_schedule import (
    Day2ScheduleError,
    Day2ScheduleRequest,
    generate_day2_schedule,
)
from football_scheduler.final_stage import (
    FinalStageConfigurationError,
    SameRankLeagueFinalStage,
    validate_final_stage_input,
)
from football_scheduler.fixtures import (
    make_maximum_mvp_request,
    make_representative_request,
    make_smoke_request,
)
from football_scheduler.league import LeagueGenerationError
from football_scheduler.league_results import (
    LeagueResultsError,
    LeagueStandingsRequest,
    calculate_league_standings,
)
from football_scheduler.same_rank_league import (
    SameRankGenerationError,
    SameRankLeaguePlan,
    SameRankLeaguePlanRequest,
    generate_same_rank_league_plan,
)
from football_scheduler.same_rank_results import (
    SameRankResultsError,
    SameRankResultsRequest,
    calculate_same_rank_standings,
)
from football_scheduler.same_rank_schedule import (
    SameRankDay2ScheduleRequest,
    SameRankScheduleError,
    generate_same_rank_day2_schedule,
)
from football_scheduler.same_rank_validator import validate_same_rank_day2_schedule
from football_scheduler.schedule_creation import ScheduleCreationRequest
from football_scheduler.solver import solve_schedule
from football_scheduler.tournament import (
    TournamentGenerationError,
    TournamentPlan,
    TournamentPlanRequest,
    generate_tournament_plan,
)
from football_scheduler.tournament_results import (
    TournamentResultsError,
    TournamentResultsRequest,
    calculate_tournament_standings,
)
from football_scheduler.validator import validate_day2_schedule, validate_schedule

SCHEMA_VERSION = "0.2.0"
MAX_REQUEST_BYTES = 1_000_000
MAX_TEAMS = 32
MAX_COURTS = 16
MAX_MATCHES = 512
MAX_SECTIONS = 128
DEFAULT_SOLVER_MAX_TIME_SECONDS = 30.0
SCHEDULE_CREATION_MAX_TIME_SECONDS = 25.0


class _RequestError(ValueError):
    """利用者が修正できるリクエストエラー。"""

    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


def handle_request(payload: dict[str, Any]) -> dict[str, Any]:
    """大会設定を検証し、スケジュールと独立検証結果を返す。

    ``payload`` は ``fixture`` を指定する技術検証用形式、または
    ``ScheduleRequest`` の JSON 表現を受け付ける。想定外の例外を含め、
    呼び出し元へ Python の例外やスタックトレースを漏らさない。
    """

    try:
        if not isinstance(payload, dict):
            raise _RequestError(
                "INVALID_REQUEST",
                "リクエストはJSONオブジェクトで送信してください。",
            )

        _validate_json_size(payload)
        if "fixture" not in payload:
            _require_supported_schema(payload)
        if payload.get("request_kind") == "league_standings":
            _validate_league_standings_limits(payload)
            return _to_json_object(
                calculate_league_standings(LeagueStandingsRequest.model_validate(payload))
            )
        if payload.get("request_kind") == "tournament_plan":
            return _generate_tournament_plan_response(payload)
        if payload.get("request_kind") == "tournament_results":
            _validate_tournament_results_limits(payload)
            return _to_json_object(
                calculate_tournament_standings(TournamentResultsRequest.model_validate(payload))
            )
        if payload.get("request_kind") == "same_rank_league_plan":
            return _generate_same_rank_plan_response(payload)
        if payload.get("request_kind") == "same_rank_league_results":
            _validate_same_rank_results_limits(payload)
            return _to_json_object(
                calculate_same_rank_standings(SameRankResultsRequest.model_validate(payload))
            )
        if payload.get("request_kind") == "same_rank_day2_schedule":
            return _generate_same_rank_schedule_response(payload)
        if payload.get("request_kind") == "schedule_creation":
            return _generate_schedule_creation_response(payload)
        if payload.get("request_kind") == "day2_creation":
            return _generate_day2_creation_response(payload)
        if payload.get("request_kind") == "day2_schedule":
            return _generate_day2_schedule_response(payload)

        request_data, response_metadata, fallback_request_data = _resolve_request(payload)
        _validate_limits(request_data)
        request_data = _apply_solver_time_limit(request_data)
        if fallback_request_data is not None:
            fallback_request_data = _apply_solver_time_limit(fallback_request_data)

        result = solve_schedule(request_data)
        result_data = _to_json_object(result)
        if result_data.get("status") == "INFEASIBLE" and fallback_request_data is not None:
            request_data = fallback_request_data
            result = solve_schedule(request_data)
            result_data = _to_json_object(result)
        document = _build_validation_document(request_data, result_data)
        validation = _to_json_object(validate_schedule(document))

        response = {**result_data, **response_metadata, "validation": validation}
        return _json_round_trip(response)
    except _RequestError as exc:
        return _error_response(exc.code, exc.message, exc.details)
    except LeagueGenerationError as exc:
        return _error_response(exc.code, exc.message, exc.details)
    except LeagueResultsError as exc:
        return _error_response(exc.code, exc.message, exc.details)
    except TournamentGenerationError as exc:
        return _error_response(exc.code, exc.message, exc.details)
    except TournamentResultsError as exc:
        return _error_response(exc.code, exc.message, exc.details)
    except SameRankGenerationError as exc:
        return _error_response(exc.code, exc.message, exc.details)
    except SameRankResultsError as exc:
        return _error_response(exc.code, exc.message, exc.details)
    except SameRankScheduleError as exc:
        return _error_response(exc.code, exc.message, exc.details)
    except Day2ScheduleError as exc:
        return _error_response(exc.code, exc.message, exc.details)
    except FinalStageConfigurationError as exc:
        return _error_response(exc.code, exc.message, exc.details)
    except ValidationError as exc:
        return _validation_error_response(exc, payload)
    except (TypeError, ValueError) as exc:
        return _error_response(
            "INPUT_SCHEMA_INVALID",
            "大会設定を読み取れませんでした。入力内容を確認してください。",
            {"reason": _safe_exception_reason(exc)},
        )
    except Exception:
        # エンドユーザーへ内部実装、パス、スタックトレースを出さない。
        return _error_response(
            "SCHEDULE_GENERATION_FAILED",
            "日程の生成中に予期しない問題が発生しました。入力を保存してから、もう一度お試しください。",
        )


def _require_supported_schema(payload: Mapping[str, Any]) -> None:
    received = payload.get("schema_version")
    if received == SCHEMA_VERSION:
        return
    raise _RequestError(
        "SCHEMA_VERSION_UNSUPPORTED",
        "この大会データは現在の生成機能では使用できません。アプリを更新するか、編集用コピーへ変換してください。",
        received_schema_version=str(received) if received is not None else "missing",
        supported_schema_version=SCHEMA_VERSION,
    )


def _validate_request_final_stage(payload: Mapping[str, Any]) -> None:
    request_kind = payload.get("request_kind")
    if request_kind == "day1_league":
        teams = payload.get("teams")
        league = payload.get("league")
        validate_final_stage_input(
            payload.get("final_stage"),
            team_count=(
                len(teams)
                if isinstance(teams, Sequence) and not isinstance(teams, (str, bytes, bytearray))
                else None
            ),
            block_count=(
                int(league["block_count"])
                if isinstance(league, Mapping) and isinstance(league.get("block_count"), int)
                else None
            ),
        )
        return
    if request_kind not in {
        "tournament_plan",
        "same_rank_league_plan",
        "day2_creation",
        "schedule_creation",
    }:
        return
    if request_kind == "schedule_creation":
        teams = payload.get("teams")
        league = payload.get("league")
        validate_final_stage_input(
            payload.get("final_stage"),
            team_count=(
                len(teams)
                if isinstance(teams, Sequence) and not isinstance(teams, (str, bytes, bytearray))
                else None
            ),
            block_count=(
                int(league["block_count"])
                if isinstance(league, Mapping) and isinstance(league.get("block_count"), int)
                else None
            ),
        )
        return
    league_plan = payload.get("league_plan")
    blocks = league_plan.get("blocks") if isinstance(league_plan, Mapping) else None
    if not isinstance(blocks, Sequence) or isinstance(blocks, (str, bytes, bytearray)):
        team_count = None
        block_count = None
    else:
        block_count = len(blocks)
        team_count = sum(
            len(block.get("team_ids", ()))
            for block in blocks
            if isinstance(block, Mapping)
            and isinstance(block.get("team_ids"), Sequence)
            and not isinstance(block.get("team_ids"), (str, bytes, bytearray))
        )
    validate_final_stage_input(
        payload.get("final_stage"),
        team_count=team_count,
        block_count=block_count,
    )


def _generate_tournament_plan_response(payload: Mapping[str, Any]) -> dict[str, Any]:
    _validate_tournament_plan_limits(payload)
    _validate_request_final_stage(payload)
    return _to_json_object(generate_tournament_plan(TournamentPlanRequest.model_validate(payload)))


def _generate_same_rank_plan_response(payload: Mapping[str, Any]) -> dict[str, Any]:
    _validate_tournament_plan_limits(payload)
    _validate_request_final_stage(payload)
    return _to_json_object(
        generate_same_rank_league_plan(SameRankLeaguePlanRequest.model_validate(payload))
    )


def _generate_day2_schedule_response(payload: Mapping[str, Any]) -> dict[str, Any]:
    _validate_day2_schedule_limits(payload)
    request_data = _apply_solver_time_limit(payload)
    request = Day2ScheduleRequest.model_validate(request_data)
    day1_document = _build_day1_source_validation_document(request_data)
    day1_validation = _to_json_object(validate_schedule(day1_document))
    if day1_validation.get("valid") is not True:
        raise _RequestError(
            "DAY1_SCHEDULE_INVALID",
            "既存の1日目日程が大会規則の検証に合格しません。1日目日程を再作成してください。",
            diagnostics=list(day1_validation.get("diagnostics", [])),
        )
    schedule = generate_day2_schedule(request)
    result_data = _to_json_object(schedule)
    if result_data.get("status") not in {"OPTIMAL", "FEASIBLE"}:
        return result_data
    day2_document = _build_day2_validation_document(request_data, result_data)
    validation = _to_json_object(validate_day2_schedule(day2_document))
    integrated_validation = _integrated_validation(day1_validation, validation)
    return _json_round_trip(
        {
            **result_data,
            "validation": validation,
            "integrated_validation": integrated_validation,
        }
    )


def _generate_same_rank_schedule_response(payload: Mapping[str, Any]) -> dict[str, Any]:
    _validate_day2_schedule_limits(payload)
    request_data = _apply_solver_time_limit(payload)
    request = SameRankDay2ScheduleRequest.model_validate(request_data)
    day1_document = _build_day1_source_validation_document(request_data)
    day1_validation = _to_json_object(validate_schedule(day1_document))
    if day1_validation.get("valid") is not True:
        raise _RequestError(
            "DAY1_SCHEDULE_INVALID",
            "既存の1日目日程が大会規則の検証に合格しません。1日目日程を再作成してください。",
            diagnostics=list(day1_validation.get("diagnostics", [])),
        )
    schedule = generate_same_rank_day2_schedule(request)
    result_data = _to_json_object(schedule)
    if result_data.get("status") not in {"OPTIMAL", "FEASIBLE"}:
        return result_data
    validation = _to_json_object(validate_same_rank_day2_schedule(request, schedule))
    integrated_validation = _integrated_validation(day1_validation, validation)
    return _json_round_trip(
        {
            **result_data,
            "validation": validation,
            "integrated_validation": integrated_validation,
        }
    )


def _generate_day2_creation_response(payload: Mapping[str, Any]) -> dict[str, Any]:
    same_rank = (
        isinstance(payload.get("final_stage"), Mapping)
        and payload["final_stage"].get("format") == "same_rank_league"
    )
    plan_stage = "same_rank_league_plan" if same_rank else "tournament_plan"
    prepared = _run_day2_creation_stage(
        plan_stage,
        {"COMPLETE"},
        lambda: _prepare_day2_creation(payload),
    )
    if prepared.get("status") != "COMPLETE":
        return prepared
    request = Day2CreationRequest.model_validate(prepared["request"])

    if isinstance(request.final_stage, SameRankLeagueFinalStage):
        same_rank_response = _run_day2_creation_stage(
            "same_rank_league_plan",
            {"COMPLETE"},
            lambda: _generate_same_rank_plan_response(_to_json_object(request.same_rank_request())),
        )
        if same_rank_response.get("status") != "COMPLETE":
            return same_rank_response
        schedule_response = _run_day2_creation_stage(
            "same_rank_day2_schedule",
            {"OPTIMAL", "FEASIBLE"},
            lambda: _generate_same_rank_schedule_from_creation(request, same_rank_response),
        )
        return _finish_day2_creation(
            schedule_response,
            plan_key="same_rank_plan",
            plan_response=same_rank_response,
        )

    tournament_response = _run_day2_creation_stage(
        "tournament_plan",
        {"COMPLETE"},
        lambda: _generate_tournament_plan_response(_to_json_object(request.tournament_request())),
    )
    if tournament_response.get("status") != "COMPLETE":
        return tournament_response

    schedule_response = _run_day2_creation_stage(
        "day2_schedule",
        {"OPTIMAL", "FEASIBLE"},
        lambda: _generate_day2_schedule_from_creation(request, tournament_response),
    )
    return _finish_day2_creation(
        schedule_response,
        plan_key="tournament_plan",
        plan_response=tournament_response,
    )


def _generate_schedule_creation_response(payload: Mapping[str, Any]) -> dict[str, Any]:
    prepared = _run_day2_creation_stage(
        "input",
        {"COMPLETE"},
        lambda: _prepare_schedule_creation(payload),
    )
    if prepared.get("status") != "COMPLETE":
        return prepared
    request = ScheduleCreationRequest.model_validate(prepared["request"])
    operation_started = monotonic()

    if request.generation_scope == "all":
        day1_response = _run_day2_creation_stage(
            "day1_schedule",
            {"OPTIMAL", "FEASIBLE"},
            lambda: _generate_day1_schedule_response(_to_json_object(request.day1_request())),
        )
        if day1_response.get("status") not in {"OPTIMAL", "FEASIBLE"}:
            return day1_response
        validation = day1_response.get("validation")
        if not isinstance(validation, Mapping) or validation.get("valid") is not True:
            return _error_response(
                "DAY1_VALIDATION_FAILED",
                "生成した1日目日程が大会規則の安全確認に合格しませんでした。入力を保存して、もう一度お試しください。",
                {"operation_stage": "day1_schedule"},
            )
        base_result = day1_response
    else:
        if request.existing_result is None:  # model validatorで保証する防御的分岐
            raise _RequestError(
                "DAY1_RESULT_REQUIRED",
                "2日目だけを作成するには、既存の1日目日程が必要です。",
            )
        base_result = _json_round_trip(request.existing_result)

    try:
        day2_payload = _day2_creation_payload(request, base_result)
    except _RequestError as exc:
        return _with_operation_stage(
            _error_response(exc.code, exc.message, exc.details),
            "day1_schedule",
        )
    if request.generation_scope == "all":
        try:
            day2_payload = _apply_schedule_creation_remaining_budget(
                day2_payload,
                operation_started=operation_started,
            )
        except _RequestError as exc:
            return _with_operation_stage(
                _error_response(exc.code, exc.message, exc.details),
                "day2_schedule",
            )
    day2_response = _generate_day2_creation_response(day2_payload)
    if day2_response.get("status") not in {"OPTIMAL", "FEASIBLE"}:
        return _normalize_schedule_creation_failure(day2_response)
    day2_response = _restore_schedule_creation_public_solver_metrics(
        day2_response,
        max_time_seconds=request.solver.max_time_seconds,
    )

    day2_schedule = day2_response.get("day2_schedule")
    integrated_validation = (
        day2_schedule.get("integrated_validation") if isinstance(day2_schedule, Mapping) else None
    )
    if (
        not isinstance(integrated_validation, Mapping)
        or integrated_validation.get("valid") is not True
    ):
        return _error_response(
            "DAY2_VALIDATION_FAILED",
            "生成した両日の日程が大会規則の安全確認に合格しませんでした。入力を保存して、もう一度お試しください。",
            {"operation_stage": "integrated_validation"},
        )

    tournament_result = _merge_schedule_creation_result(base_result, day2_response)
    return _json_round_trip(
        {
            "schema_version": SCHEMA_VERSION,
            "status": day2_response["status"],
            "generation_scope": request.generation_scope,
            "tournament_result": tournament_result,
        }
    )


def _prepare_schedule_creation(payload: Mapping[str, Any]) -> dict[str, Any]:
    _validate_limits(payload)
    _validate_request_final_stage(payload)
    request_data = _apply_solver_time_limit(payload)
    request = ScheduleCreationRequest.model_validate(request_data)
    if (
        request.generation_scope == "all"
        and request.solver.max_time_seconds > SCHEDULE_CREATION_MAX_TIME_SECONDS
    ):
        request = request.model_copy(
            update={
                "solver": request.solver.model_copy(
                    update={"max_time_seconds": SCHEDULE_CREATION_MAX_TIME_SECONDS}
                )
            }
        )
    return {"status": "COMPLETE", "request": _to_json_object(request)}


def _apply_schedule_creation_remaining_budget(
    payload: Mapping[str, Any],
    *,
    operation_started: float,
) -> dict[str, Any]:
    remaining = SCHEDULE_CREATION_MAX_TIME_SECONDS - (monotonic() - operation_started)
    if remaining <= 0.1:
        raise _RequestError(
            "SCHEDULE_SEARCH_TIMEOUT",
            "日程生成が時間上限に達しました。入力を保存して、もう一度お試しください。",
            maximum_seconds=SCHEDULE_CREATION_MAX_TIME_SECONDS,
        )
    adjusted = deepcopy(dict(payload))
    solver = adjusted.get("solver")
    solver_data = dict(solver) if isinstance(solver, Mapping) else {}
    requested = solver_data.get("max_time_seconds", remaining)
    if isinstance(requested, bool) or not isinstance(requested, (int, float)):
        requested = remaining
    solver_data["max_time_seconds"] = max(0.1, min(float(requested), remaining))
    adjusted["solver"] = solver_data
    return adjusted


def _restore_schedule_creation_public_solver_metrics(
    response: Mapping[str, Any],
    *,
    max_time_seconds: float,
) -> dict[str, Any]:
    """内部の残り時間ではなく、公開要求の上限を監査値として返す。"""

    restored = _json_round_trip(response)
    schedule = restored.get("day2_schedule")
    metrics = schedule.get("metrics") if isinstance(schedule, Mapping) else None
    if isinstance(metrics, dict):
        metrics["max_time_seconds"] = max_time_seconds
    return restored


def _normalize_schedule_creation_failure(response: Mapping[str, Any]) -> dict[str, Any]:
    normalized = _json_round_trip(response)
    diagnostics = normalized.get("diagnostics")
    if not isinstance(diagnostics, list):
        return normalized
    stage_map = {
        "tournament_plan": "final_stage_plan",
        "same_rank_league_plan": "final_stage_plan",
        "day2_schedule": "day2_schedule",
        "same_rank_day2_schedule": "day2_schedule",
        "integrated_validation": "integrated_validation",
    }
    for diagnostic in diagnostics:
        if not isinstance(diagnostic, dict):
            continue
        details = diagnostic.get("details")
        if not isinstance(details, dict):
            continue
        stage = details.get("operation_stage")
        if isinstance(stage, str):
            details["operation_stage"] = stage_map.get(stage, stage)
    return normalized


def _generate_day1_schedule_response(payload: Mapping[str, Any]) -> dict[str, Any]:
    request_data, response_metadata, fallback_request_data = _resolve_request(payload)
    _validate_limits(request_data)
    request_data = _apply_solver_time_limit(request_data)
    if fallback_request_data is not None:
        fallback_request_data = _apply_solver_time_limit(fallback_request_data)

    result = solve_schedule(request_data)
    result_data = _to_json_object(result)
    if result_data.get("status") == "INFEASIBLE" and fallback_request_data is not None:
        request_data = fallback_request_data
        result = solve_schedule(request_data)
        result_data = _to_json_object(result)
    document = _build_validation_document(request_data, result_data)
    validation = _to_json_object(validate_schedule(document))
    return _json_round_trip({**result_data, **response_metadata, "validation": validation})


def _day2_creation_payload(
    request: ScheduleCreationRequest,
    tournament_result: Mapping[str, Any],
) -> dict[str, Any]:
    request_data = request.model_dump(mode="json")
    league_plan = tournament_result.get("league_plan")
    slots = tournament_result.get("slots")
    if (
        not isinstance(league_plan, Mapping)
        or not isinstance(slots, Sequence)
        or isinstance(slots, (str, bytes, bytearray))
    ):
        raise _RequestError(
            "DAY1_RESULT_REQUIRED",
            "2日目の作成に必要な1日目の日程またはブロック分けがありません。1日目から作成し直してください。",
        )
    payload: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "request_kind": "day2_creation",
        "teams": request_data["teams"],
        "courts": request_data["courts"],
        "league_plan": _json_round_trip(league_plan),
        "final_stage": request_data["final_stage"],
        "day1_schedule": {"day": request_data["day"], "slots": list(slots)},
        "day": request_data["day2"],
        "referees": request_data["referees"],
        "random_seed": request.random_seed,
        "solver": request_data["solver"],
    }
    league_standings = tournament_result.get("league_standings")
    if isinstance(league_standings, Mapping):
        payload["league_standings"] = _json_round_trip(league_standings)
    return payload


def _merge_schedule_creation_result(
    existing_result: Mapping[str, Any],
    day2_response: Mapping[str, Any],
) -> dict[str, Any]:
    merged = _json_round_trip(existing_result)
    for field in (
        "tournament_plan",
        "same_rank_plan",
        "day2_schedule",
        "integrated_validation",
        "tournament_results",
        "same_rank_league_results",
        "same_rank_standings",
        "final_standings",
    ):
        merged.pop(field, None)
    plan_key = "same_rank_plan" if "same_rank_plan" in day2_response else "tournament_plan"
    merged[plan_key] = _json_round_trip(day2_response[plan_key])
    merged["day2_schedule"] = _json_round_trip(day2_response["day2_schedule"])
    integrated_validation = day2_response["day2_schedule"].get("integrated_validation")
    if isinstance(integrated_validation, Mapping):
        merged["integrated_validation"] = _json_round_trip(integrated_validation)
    return merged


def _finish_day2_creation(
    schedule_response: dict[str, Any],
    *,
    plan_key: str,
    plan_response: Mapping[str, Any],
) -> dict[str, Any]:
    if schedule_response.get("status") not in {"OPTIMAL", "FEASIBLE"}:
        return schedule_response
    if (
        not isinstance(schedule_response.get("validation"), Mapping)
        or schedule_response["validation"].get("valid") is not True
        or not isinstance(schedule_response.get("integrated_validation"), Mapping)
        or schedule_response["integrated_validation"].get("valid") is not True
    ):
        return _error_response(
            "DAY2_VALIDATION_FAILED",
            "生成した2日目日程が大会規則の安全確認に合格しませんでした。入力を保存して、もう一度お試しください。",
            {"operation_stage": "integrated_validation"},
        )
    return _json_round_trip(
        {
            "schema_version": SCHEMA_VERSION,
            "status": schedule_response["status"],
            plan_key: plan_response,
            "day2_schedule": schedule_response,
        }
    )


def _prepare_day2_creation(payload: Mapping[str, Any]) -> dict[str, Any]:
    _validate_day2_creation_limits(payload)
    _validate_request_final_stage(payload)
    request_data = _apply_solver_time_limit(payload)
    request = Day2CreationRequest.model_validate(request_data)
    return {
        "status": "COMPLETE",
        "request": _to_json_object(request),
    }


def _generate_day2_schedule_from_creation(
    request: Day2CreationRequest,
    tournament_response: Mapping[str, Any],
) -> dict[str, Any]:
    tournament_plan = TournamentPlan.model_validate(tournament_response)
    return _generate_day2_schedule_response(
        _to_json_object(request.schedule_request(tournament_plan))
    )


def _generate_same_rank_schedule_from_creation(
    request: Day2CreationRequest,
    same_rank_response: Mapping[str, Any],
) -> dict[str, Any]:
    same_rank_plan = SameRankLeaguePlan.model_validate(same_rank_response)
    return _generate_same_rank_schedule_response(
        _to_json_object(request.same_rank_schedule_request(same_rank_plan))
    )


def _run_day2_creation_stage(
    operation_stage: str,
    success_statuses: set[str],
    operation: Callable[[], dict[str, Any]],
) -> dict[str, Any]:
    try:
        response = operation()
    except _RequestError as exc:
        response = _error_response(exc.code, exc.message, exc.details)
    except LeagueGenerationError as exc:
        response = _error_response(exc.code, exc.message, exc.details)
    except TournamentGenerationError as exc:
        response = _error_response(exc.code, exc.message, exc.details)
    except Day2ScheduleError as exc:
        response = _error_response(exc.code, exc.message, exc.details)
    except SameRankGenerationError as exc:
        response = _error_response(exc.code, exc.message, exc.details)
    except SameRankScheduleError as exc:
        response = _error_response(exc.code, exc.message, exc.details)
    except FinalStageConfigurationError as exc:
        response = _error_response(exc.code, exc.message, exc.details)
    except ValidationError as exc:
        response = _error_response(
            "INPUT_SCHEMA_INVALID",
            "大会設定の一部を読み取れませんでした。入力内容を確認してください。",
            {"errors": _pydantic_errors(exc)},
        )
    except (TypeError, ValueError) as exc:
        response = _error_response(
            "INPUT_SCHEMA_INVALID",
            "大会設定を読み取れませんでした。入力内容を確認してください。",
            {"reason": _safe_exception_reason(exc)},
        )
    except Exception:
        response = _error_response(
            "SCHEDULE_GENERATION_FAILED",
            "日程の生成中に予期しない問題が発生しました。入力を保存してから、もう一度お試しください。",
        )
    if response.get("status") in success_statuses:
        return response
    return _with_operation_stage(response, operation_stage)


def _with_operation_stage(response: Mapping[str, Any], operation_stage: str) -> dict[str, Any]:
    staged = _json_round_trip(response)
    diagnostics = staged.get("diagnostics")
    if not isinstance(diagnostics, list) or not diagnostics or not isinstance(diagnostics[0], dict):
        diagnostics = [
            {
                "code": "SCHEDULE_GENERATION_FAILED",
                "message": "2日目を作成できませんでした。入力を確認して、もう一度お試しください。",
            }
        ]
        staged["diagnostics"] = diagnostics
    first = diagnostics[0]
    details = first.get("details")
    if not isinstance(details, dict):
        details = {}
        first["details"] = details
    details["operation_stage"] = operation_stage
    return staged


def _resolve_request(
    payload: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any] | None]:
    if payload.get("request_kind") == "day1_league":
        _validate_limits(payload)
        _validate_request_final_stage(payload)
        prepared = prepare_day1_league_schedule(payload)
        fallback_request = (
            _to_json_object(prepared.fallback_request)
            if prepared.fallback_request is not None
            else None
        )
        return (
            _to_json_object(prepared.request),
            {
                "schedule_scope": "day1_league",
                "league_plan": _to_json_object(prepared.league_plan),
            },
            fallback_request,
        )

    fixture_name = payload.get("fixture")
    if fixture_name is None:
        return _json_round_trip(payload), {}, None

    allowed_keys = {"fixture", "solver_options"}
    unknown_keys = sorted(str(key) for key in payload if key not in allowed_keys)
    if unknown_keys:
        raise _RequestError(
            "INVALID_FIXTURE_REQUEST",
            "検証用入力に未対応の項目があります。",
            fields=unknown_keys,
        )

    factories = {
        "smoke": make_smoke_request,
        "representative": make_representative_request,
        "mvp_maximum": make_maximum_mvp_request,
    }
    if fixture_name not in factories:
        raise _RequestError(
            "UNKNOWN_FIXTURE",
            "指定された検証用入力が見つかりません。smoke、representative、mvp_maximumのいずれかを指定してください。",
            fixture=fixture_name,
        )

    request = _to_json_object(factories[str(fixture_name)]())
    overrides = payload.get("solver_options")
    if overrides is not None:
        if not isinstance(overrides, Mapping):
            raise _RequestError(
                "INVALID_SOLVER_OPTIONS",
                "solver_optionsはJSONオブジェクトで指定してください。",
            )
        current = request.get("solver")
        request["solver"] = {
            **(dict(current) if isinstance(current, Mapping) else {}),
            **dict(overrides),
        }
    return _json_round_trip(request), {}, None


def _apply_solver_time_limit(request: Mapping[str, Any]) -> dict[str, Any]:
    request_data = deepcopy(dict(request))
    # ``solver_options`` は外部の検証用エンベロープ名としてだけ公開する。
    # ScheduleRequest の正規フィールドは ``solver``。
    options = request_data.pop("solver_options", request_data.get("solver", None))
    if options is None:
        normalized_options: dict[str, Any] = {}
    elif isinstance(options, Mapping):
        normalized_options = dict(options)
    else:
        raise _RequestError(
            "INVALID_SOLVER_OPTIONS",
            "solver_optionsはJSONオブジェクトで指定してください。",
        )

    configured_limit = _configured_solver_limit()
    requested_limit = normalized_options.get("max_time_seconds", configured_limit)
    if isinstance(requested_limit, bool) or not isinstance(requested_limit, (int, float)):
        raise _RequestError(
            "INVALID_SOLVER_TIMEOUT",
            "ソルバーの実行時間上限は正の数で指定してください。",
        )
    if requested_limit <= 0:
        raise _RequestError(
            "INVALID_SOLVER_TIMEOUT",
            "ソルバーの実行時間上限は0秒より大きくしてください。",
        )

    normalized_options["max_time_seconds"] = min(float(requested_limit), configured_limit)
    request_data["solver"] = normalized_options
    return request_data


def _configured_solver_limit() -> float:
    raw_value = os.getenv("SOLVER_MAX_TIME_SECONDS")
    if raw_value is None or raw_value == "":
        return DEFAULT_SOLVER_MAX_TIME_SECONDS
    try:
        value = float(raw_value)
    except ValueError as exc:
        raise _RequestError(
            "SERVER_CONFIGURATION_INVALID",
            "サーバーの実行時間上限設定が不正です。管理者へ連絡してください。",
        ) from exc
    if value <= 0:
        raise _RequestError(
            "SERVER_CONFIGURATION_INVALID",
            "サーバーの実行時間上限設定が不正です。管理者へ連絡してください。",
        )
    return value


def _validate_json_size(payload: Mapping[str, Any]) -> None:
    try:
        encoded = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise _RequestError(
            "INVALID_REQUEST",
            "リクエストにはJSONとして保存できる値だけを指定してください。",
        ) from exc
    if len(encoded) > MAX_REQUEST_BYTES:
        raise _RequestError(
            "INPUT_TOO_LARGE",
            f"入力データが上限の{MAX_REQUEST_BYTES:,}バイトを超えています。",
            actual_bytes=len(encoded),
            maximum_bytes=MAX_REQUEST_BYTES,
        )


def _validate_limits(request: Mapping[str, Any]) -> None:
    _validate_sequence_limit(request, "teams", MAX_TEAMS, "チーム数", "TEAM_LIMIT_EXCEEDED")
    _validate_sequence_limit(request, "courts", MAX_COURTS, "コート数", "COURT_LIMIT_EXCEEDED")
    _validate_sequence_limit(request, "matches", MAX_MATCHES, "試合数", "MATCH_LIMIT_EXCEEDED")

    max_sections = request.get("max_sections")
    if max_sections is None:
        day = request.get("day")
        if isinstance(day, Mapping):
            max_sections = day.get("max_sections")
    if (
        isinstance(max_sections, int)
        and not isinstance(max_sections, bool)
        and max_sections > MAX_SECTIONS
    ):
        raise _RequestError(
            "SECTION_LIMIT_EXCEEDED",
            f"セクション数が上限の{MAX_SECTIONS}を超えています。",
            actual=max_sections,
            maximum=MAX_SECTIONS,
        )


def _validate_league_standings_limits(request: Mapping[str, Any]) -> None:
    _validate_sequence_limit(
        request, "results", MAX_MATCHES, "リーグ結果数", "MATCH_LIMIT_EXCEEDED"
    )
    league_plan = request.get("league_plan")
    if isinstance(league_plan, Mapping):
        _validate_sequence_limit(
            league_plan, "matches", MAX_MATCHES, "リーグ試合数", "MATCH_LIMIT_EXCEEDED"
        )


def _validate_tournament_plan_limits(request: Mapping[str, Any]) -> None:
    league_plan = request.get("league_plan")
    if isinstance(league_plan, Mapping):
        _validate_sequence_limit(
            league_plan, "matches", MAX_MATCHES, "リーグ試合数", "MATCH_LIMIT_EXCEEDED"
        )
        blocks = league_plan.get("blocks")
        if isinstance(blocks, Sequence) and not isinstance(blocks, (str, bytes, bytearray)):
            team_count = sum(
                len(team_ids)
                for block in blocks
                if isinstance(block, Mapping)
                and isinstance(team_ids := block.get("team_ids"), Sequence)
                and not isinstance(team_ids, (str, bytes, bytearray))
            )
            if team_count > MAX_TEAMS:
                raise _RequestError(
                    "TEAM_LIMIT_EXCEEDED",
                    f"チーム数が上限の{MAX_TEAMS}を超えています。",
                    actual=team_count,
                    maximum=MAX_TEAMS,
                )
    league_standings = request.get("league_standings")
    if isinstance(league_standings, Mapping):
        _validate_sequence_limit(
            league_standings,
            "standings",
            MAX_TEAMS,
            "リーグ順位数",
            "TEAM_LIMIT_EXCEEDED",
        )


def _validate_day2_schedule_limits(request: Mapping[str, Any]) -> None:
    _validate_sequence_limit(request, "teams", MAX_TEAMS, "チーム数", "TEAM_LIMIT_EXCEEDED")
    _validate_sequence_limit(request, "courts", MAX_COURTS, "コート数", "COURT_LIMIT_EXCEEDED")
    league_plan = request.get("league_plan")
    if isinstance(league_plan, Mapping):
        _validate_sequence_limit(
            league_plan, "matches", MAX_MATCHES, "リーグ試合数", "MATCH_LIMIT_EXCEEDED"
        )
        _validate_sequence_limit(
            league_plan, "blocks", MAX_TEAMS, "リーグブロック数", "TEAM_LIMIT_EXCEEDED"
        )
    day1_schedule = request.get("day1_schedule")
    if isinstance(day1_schedule, Mapping):
        _validate_sequence_limit(
            day1_schedule,
            "slots",
            MAX_SECTIONS * MAX_COURTS,
            "1日目スロット数",
            "MATCH_LIMIT_EXCEEDED",
        )
    tournament_plan = request.get("tournament_plan")
    tournament_match_count = 0
    if isinstance(tournament_plan, Mapping):
        for pool in _mapping_sequence(tournament_plan.get("pools")):
            if not isinstance(pool, Mapping):
                continue
            _validate_sequence_limit(
                pool, "seeds", MAX_TEAMS, "トーナメントシード数", "TEAM_LIMIT_EXCEEDED"
            )
            matches = pool.get("matches")
            if isinstance(matches, Sequence) and not isinstance(matches, (str, bytes, bytearray)):
                tournament_match_count += len(matches)
    same_rank_plan = request.get("same_rank_plan")
    if isinstance(same_rank_plan, Mapping):
        for group in _mapping_sequence(same_rank_plan.get("groups")):
            matches = group.get("matches")
            if isinstance(matches, Sequence) and not isinstance(matches, (str, bytes, bytearray)):
                tournament_match_count += len(matches)
    if tournament_match_count > MAX_MATCHES:
        raise _RequestError(
            "MATCH_LIMIT_EXCEEDED",
            f"2日目試合数が上限の{MAX_MATCHES}を超えています。",
            actual=tournament_match_count,
            maximum=MAX_MATCHES,
        )
    day = request.get("day")
    if isinstance(day, Mapping):
        maximum = day.get("max_sections")
        if isinstance(maximum, int) and not isinstance(maximum, bool) and maximum > MAX_SECTIONS:
            raise _RequestError(
                "SECTION_LIMIT_EXCEEDED",
                f"セクション数が上限の{MAX_SECTIONS}を超えています。",
                actual=maximum,
                maximum=MAX_SECTIONS,
            )


def _validate_day2_creation_limits(request: Mapping[str, Any]) -> None:
    _validate_tournament_plan_limits(request)
    _validate_day2_schedule_limits(request)


def _validate_tournament_results_limits(request: Mapping[str, Any]) -> None:
    _validate_sequence_limit(
        request,
        "results",
        MAX_MATCHES,
        "トーナメント結果数",
        "MATCH_LIMIT_EXCEEDED",
    )
    tournament_plan = request.get("tournament_plan")
    if not isinstance(tournament_plan, Mapping):
        return
    tournament_match_count = 0
    tournament_team_count = 0
    for pool in _mapping_sequence(tournament_plan.get("pools")):
        if not isinstance(pool, Mapping):
            continue
        matches = pool.get("matches")
        if isinstance(matches, Sequence) and not isinstance(matches, (str, bytes, bytearray)):
            tournament_match_count += len(matches)
        seeds = pool.get("seeds")
        if isinstance(seeds, Sequence) and not isinstance(seeds, (str, bytes, bytearray)):
            tournament_team_count += len(seeds)
    if tournament_match_count > MAX_MATCHES:
        raise _RequestError(
            "MATCH_LIMIT_EXCEEDED",
            f"2日目試合数が上限の{MAX_MATCHES}を超えています。",
            actual=tournament_match_count,
            maximum=MAX_MATCHES,
        )
    if tournament_team_count > MAX_TEAMS:
        raise _RequestError(
            "TEAM_LIMIT_EXCEEDED",
            f"チーム数が上限の{MAX_TEAMS}を超えています。",
            actual=tournament_team_count,
            maximum=MAX_TEAMS,
        )


def _validate_same_rank_results_limits(request: Mapping[str, Any]) -> None:
    _validate_sequence_limit(
        request,
        "results",
        MAX_MATCHES,
        "同順位リーグ結果数",
        "MATCH_LIMIT_EXCEEDED",
    )
    same_rank_plan = request.get("same_rank_plan")
    match_count = 0
    if isinstance(same_rank_plan, Mapping):
        for group in _mapping_sequence(same_rank_plan.get("groups")):
            matches = group.get("matches")
            if isinstance(matches, Sequence) and not isinstance(matches, (str, bytes, bytearray)):
                match_count += len(matches)
    if match_count > MAX_MATCHES:
        raise _RequestError(
            "MATCH_LIMIT_EXCEEDED",
            f"同順位リーグ試合数が上限の{MAX_MATCHES}を超えています。",
            actual=match_count,
            maximum=MAX_MATCHES,
        )


def _validate_sequence_limit(
    request: Mapping[str, Any],
    field: str,
    maximum: int,
    label: str,
    code: str,
) -> None:
    value = request.get(field)
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return
    if len(value) > maximum:
        raise _RequestError(
            code,
            f"{label}が上限の{maximum}を超えています。",
            actual=len(value),
            maximum=maximum,
        )


def _mapping_sequence(value: object) -> tuple[Mapping[str, Any], ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return ()
    return tuple(item for item in value if isinstance(item, Mapping))


def _build_validation_document(
    request: Mapping[str, Any], result: Mapping[str, Any]
) -> dict[str, Any]:
    """ソルバーのモデルから独立検証器の正規形を組み立てる。"""

    config = deepcopy(dict(request))
    raw_day = request.get("day")
    day_id = str(raw_day.get("id", "day1") if isinstance(raw_day, Mapping) else "day1")
    if "days" not in config:
        day_settings = dict(raw_day) if isinstance(raw_day, Mapping) else {}
        if "max_sections" not in day_settings and request.get("max_sections") is not None:
            day_settings["max_sections"] = request["max_sections"]
        config["days"] = {day_id: day_settings}
    if "referees" not in config:
        config["referees"] = {
            "organizer_capacity": request.get("organizer_capacity", len(request.get("courts", [])))
        }

    matches = deepcopy(list(request.get("matches", [])))
    for match in matches:
        if isinstance(match, dict) and "dependencies" not in match:
            prerequisites = match.get("prerequisite_match_ids")
            if isinstance(prerequisites, list):
                match["dependencies"] = list(prerequisites)

    slots = deepcopy(list(result.get("slots", [])))
    for slot in slots:
        if not isinstance(slot, dict):
            continue
        assignment = slot.get("referee_assignment")
        if isinstance(assignment, dict) and "type" not in assignment:
            kind = assignment.get("kind")
            if kind is not None:
                assignment["type"] = kind
    return {
        "schema_version": request.get("schema_version", SCHEMA_VERSION),
        "config": config,
        "matches": matches,
        "schedule": {"slots": slots},
    }


def _build_day2_validation_document(
    request: Mapping[str, Any], result: Mapping[str, Any]
) -> dict[str, Any]:
    slots = deepcopy(list(result.get("slots", [])))
    matches = deepcopy(list(result.get("tournament_matches", [])))
    return {
        "schema_version": request.get("schema_version", SCHEMA_VERSION),
        "participant_resolution": result.get(
            "participant_resolution",
            request.get("tournament_plan", {}).get("participant_resolution", "resolved")
            if isinstance(request.get("tournament_plan"), Mapping)
            else "resolved",
        ),
        "config": {
            "teams": deepcopy(list(request.get("teams", []))),
            "courts": deepcopy(list(request.get("courts", []))),
            "days": {"day2": deepcopy(dict(request.get("day", {})))},
            "referees": deepcopy(dict(request.get("referees", {}))),
            "tournament_plan": deepcopy(dict(request.get("tournament_plan", {}))),
        },
        "league_plan": deepcopy(dict(request.get("league_plan", {}))),
        "day1_schedule": deepcopy(dict(request.get("day1_schedule", {}))),
        "tournament_plan": deepcopy(dict(request.get("tournament_plan", {}))),
        "matches": matches,
        "team_schedules": deepcopy(list(result.get("team_schedules", []))),
        "schedule": {
            "slots": slots,
            "section_timings": deepcopy(list(result.get("section_timings", []))),
            "expected_end_time": result.get("expected_end_time"),
            "participant_resolution": result.get("participant_resolution", "resolved"),
            "team_schedules": deepcopy(list(result.get("team_schedules", []))),
            "metrics": deepcopy(dict(result.get("metrics", {}))),
        },
        "metrics": deepcopy(dict(result.get("metrics", {}))),
    }


def _build_day1_source_validation_document(request: Mapping[str, Any]) -> dict[str, Any]:
    source = request.get("day1_schedule")
    source_data = dict(source) if isinstance(source, Mapping) else {}
    day = source_data.get("day")
    league_plan = request.get("league_plan")
    matches = (
        deepcopy(list(league_plan.get("matches", []))) if isinstance(league_plan, Mapping) else []
    )
    slots = deepcopy(list(source_data.get("slots", [])))
    for slot in slots:
        if not isinstance(slot, dict):
            continue
        assignment = slot.get("referee_assignment")
        if isinstance(assignment, dict) and "type" not in assignment and "kind" in assignment:
            assignment["type"] = assignment["kind"]
    return {
        "schema_version": request.get("schema_version", SCHEMA_VERSION),
        "config": {
            "teams": deepcopy(list(request.get("teams", []))),
            "courts": deepcopy(list(request.get("courts", []))),
            "days": {"day1": deepcopy(dict(day)) if isinstance(day, Mapping) else {}},
            "referees": deepcopy(dict(request.get("referees", {}))),
        },
        "matches": matches,
        "schedule": {"slots": slots},
    }


def _integrated_validation(day1: Mapping[str, Any], day2: Mapping[str, Any]) -> dict[str, Any]:
    day1_diagnostics = day1.get("diagnostics")
    day2_diagnostics = day2.get("diagnostics")
    diagnostics = [
        *(
            deepcopy(list(day1_diagnostics))
            if isinstance(day1_diagnostics, Sequence)
            and not isinstance(day1_diagnostics, (str, bytes, bytearray))
            else []
        ),
        *(
            deepcopy(list(day2_diagnostics))
            if isinstance(day2_diagnostics, Sequence)
            and not isinstance(day2_diagnostics, (str, bytes, bytearray))
            else []
        ),
    ]
    return {
        "valid": day1.get("valid") is True and day2.get("valid") is True,
        "diagnostics": diagnostics,
        "summary": {
            "day1": deepcopy(dict(day1.get("summary", {})))
            if isinstance(day1.get("summary"), Mapping)
            else {},
            "day2": deepcopy(dict(day2.get("summary", {})))
            if isinstance(day2.get("summary"), Mapping)
            else {},
            "error_count": len(diagnostics),
        },
    }


def _to_json_object(value: Any) -> dict[str, Any]:
    if hasattr(value, "model_dump") and callable(value.model_dump):
        value = value.model_dump(mode="json")
    if not isinstance(value, Mapping):
        raise TypeError("結果はJSONオブジェクトである必要があります。")
    return _json_round_trip(value)


def _json_round_trip(value: Mapping[str, Any]) -> dict[str, Any]:
    decoded = json.loads(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    )
    if not isinstance(decoded, dict):
        raise TypeError("値はJSONオブジェクトである必要があります。")
    return decoded


def _pydantic_errors(exc: ValidationError) -> list[dict[str, Any]]:
    errors: list[dict[str, Any]] = []
    for error in exc.errors(include_url=False, include_context=False):
        location = ".".join(str(part) for part in error.get("loc", ()))
        errors.append(
            {
                "field": location,
                "message": "入力値または入力形式が正しくありません。",
                "type": str(error.get("type", "validation_error")),
            }
        )
    return errors


_TOURNAMENT_SCORE_FIELDS = frozenset(
    {
        "regular_score_home",
        "regular_score_away",
        "penalty_score_home",
        "penalty_score_away",
    }
)


def _validation_error_response(exc: ValidationError, payload: Mapping[str, Any]) -> dict[str, Any]:
    errors = _pydantic_errors(exc)
    if payload.get("request_kind") != "tournament_results":
        return _error_response(
            "INPUT_SCHEMA_INVALID",
            "大会設定の一部を読み取れませんでした。入力内容を確認してください。",
            {"errors": errors},
        )

    score_errors: list[dict[str, Any]] = []
    raw_results = payload.get("results")
    for raw_error, error in zip(
        exc.errors(include_url=False, include_context=False), errors, strict=True
    ):
        location = raw_error.get("loc", ())
        if (
            len(location) != 3
            or location[0] != "results"
            or not isinstance(location[1], int)
            or location[2] not in _TOURNAMENT_SCORE_FIELDS
        ):
            break
        result_index = location[1]
        result = (
            raw_results[result_index]
            if isinstance(raw_results, Sequence)
            and not isinstance(raw_results, (str, bytes, bytearray))
            and 0 <= result_index < len(raw_results)
            else None
        )
        match_id = result.get("match_id") if isinstance(result, Mapping) else None
        score_errors.append(
            {
                **error,
                "match_id": str(match_id) if isinstance(match_id, str) else None,
                "score_field": str(location[2]),
                "message": "得点は0以上の整数で入力してください。",
            }
        )
    else:
        if score_errors:
            return _error_response(
                "INPUT_SCHEMA_INVALID",
                "得点欄に0以上の整数を入力してください。入力済みのほかの結果は保持されています。",
                {"scope": "tournament_scores", "errors": score_errors},
            )

    return _error_response(
        "INPUT_SCHEMA_INVALID",
        "保存された2日目の計画と結果の整合性を確認できませんでした。入力した結果は保持されています。ページを再読み込みして、もう一度お試しください。",
        {"scope": "tournament_data"},
    )


def _safe_exception_reason(exc: Exception) -> str:
    # ValueError の本文にはモデルが定義した入力診断が含まれる一方、
    # repr はパス等を含み得るため利用しない。
    reason = str(exc).strip()
    return reason[:300] if reason else "入力値または入力形式が正しくありません。"


def _error_response(
    code: str, message: str, details: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    diagnostic: dict[str, Any] = {"code": code, "message": message}
    if details:
        diagnostic["details"] = _json_round_trip(details)
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "error",
        "diagnostics": [diagnostic],
    }
