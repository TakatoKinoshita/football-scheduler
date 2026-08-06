"""FaaS から独立したスケジュール生成のアプリケーション境界。

トランスポート固有のイベント形式は扱わず、JSON 互換の辞書を受け取って
JSON 互換の辞書を返す。入力上限とソルバー実行時間の上限もこの境界で
一貫して適用する。
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping, Sequence
from copy import deepcopy
from typing import Any

from pydantic import ValidationError

from football_scheduler.day1_league import prepare_day1_league_schedule
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
from football_scheduler.solver import solve_schedule
from football_scheduler.tournament import (
    TournamentGenerationError,
    TournamentPlanRequest,
    generate_tournament_plan,
)
from football_scheduler.validator import validate_schedule

SCHEMA_VERSION = "0.1.0"
MAX_REQUEST_BYTES = 1_000_000
MAX_TEAMS = 32
MAX_COURTS = 16
MAX_MATCHES = 512
MAX_SECTIONS = 128
DEFAULT_SOLVER_MAX_TIME_SECONDS = 30.0


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
        if payload.get("request_kind") == "league_standings":
            _validate_league_standings_limits(payload)
            return _to_json_object(
                calculate_league_standings(LeagueStandingsRequest.model_validate(payload))
            )
        if payload.get("request_kind") == "tournament_plan":
            _validate_tournament_plan_limits(payload)
            return _to_json_object(
                generate_tournament_plan(TournamentPlanRequest.model_validate(payload))
            )

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
    except ValidationError as exc:
        return _error_response(
            "INPUT_SCHEMA_INVALID",
            "大会設定の一部を読み取れませんでした。項目別の説明に沿って修正してください。",
            {"errors": _pydantic_errors(exc)},
        )
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


def _resolve_request(
    payload: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any] | None]:
    if payload.get("request_kind") == "day1_league":
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
