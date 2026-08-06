"""日程のセクション時刻を分単位で計算する。"""

from __future__ import annotations

from datetime import time

from football_scheduler.models import DaySettings, SectionTiming


class DayTimingError(ValueError):
    """利用者が修正できる開催時刻の矛盾。"""

    def __init__(self, code: str, message: str, **details: object) -> None:
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


def resolve_max_sections(day: DaySettings, default_horizon: int) -> int:
    """明示上限または終了時刻から利用できるセクション数を返す。"""

    if day.end_time is None:
        available_before_midnight = 0
        while (
            available_before_midnight < 512
            and _match_end_minutes(day, available_before_midnight + 1) < 24 * 60
        ):
            available_before_midnight += 1
        if available_before_midnight == 0:
            raise DayTimingError(
                "DAY_OVERRUNS_MIDNIGHT",
                "開始時刻から日付が変わるまでに1試合を行う時間がありません。",
            )
        requested = day.max_sections or default_horizon
        return min(requested, available_before_midnight)

    start = _minutes(day.start_time)
    end = _minutes(day.end_time)
    if end <= start:
        raise DayTimingError(
            "DAY_END_TIME_INVALID",
            "終了時刻は開始時刻より後にしてください。",
            start_time=day.start_time.isoformat(timespec="minutes"),
            end_time=day.end_time.isoformat(timespec="minutes"),
        )

    available = 0
    while available < 512 and _match_end_minutes(day, available + 1) <= end:
        available += 1
    if available == 0:
        raise DayTimingError(
            "DAY_TIME_WINDOW_TOO_SHORT",
            "開始時刻から終了時刻までに1試合を行う時間がありません。",
            game_duration_minutes=day.game_duration_minutes,
        )
    if day.max_sections is not None and day.max_sections > available:
        raise DayTimingError(
            "DAY_SECTION_LIMIT_CONFLICT",
            "最大セクション数では終了時刻を超えるため、どちらかを修正してください。",
            max_sections=day.max_sections,
            sections_available_by_end_time=available,
        )
    return day.max_sections or available


def section_timings(day: DaySettings, section_count: int) -> tuple[SectionTiming, ...]:
    """使用するセクション分の開始・終了時刻を生成する。"""

    breaks = {item.after_section: item.duration_minutes for item in day.breaks}
    timings: list[SectionTiming] = []
    for section_no in range(1, section_count + 1):
        start = _section_start_minutes(day, section_no)
        end = start + day.game_duration_minutes
        if end >= 24 * 60:
            raise DayTimingError(
                "DAY_OVERRUNS_MIDNIGHT",
                "日程が日付をまたぐため、開始時刻またはセクション数を修正してください。",
                section_no=section_no,
            )
        timings.append(
            SectionTiming(
                day_id=day.id,
                section_no=section_no,
                start_time=_time_from_minutes(start),
                match_end_time=_time_from_minutes(end),
                break_after_minutes=breaks.get(section_no, 0),
            )
        )
    return tuple(timings)


def expected_end_time(day: DaySettings, section_count: int) -> time | None:
    if section_count <= 0:
        return None
    return _time_from_minutes(_match_end_minutes(day, section_count))


def _section_start_minutes(day: DaySettings, section_no: int) -> int:
    before = sum(item.duration_minutes for item in day.breaks if item.after_section < section_no)
    return (
        _minutes(day.start_time)
        + (section_no - 1) * (day.game_duration_minutes + day.margin_minutes)
        + before
    )


def _match_end_minutes(day: DaySettings, section_no: int) -> int:
    return _section_start_minutes(day, section_no) + day.game_duration_minutes


def _minutes(value: time) -> int:
    return value.hour * 60 + value.minute


def _time_from_minutes(value: int) -> time:
    if not 0 <= value < 24 * 60:
        raise DayTimingError(
            "DAY_OVERRUNS_MIDNIGHT",
            "日程が日付をまたぐため、開始時刻またはセクション数を修正してください。",
        )
    return time(value // 60, value % 60)
