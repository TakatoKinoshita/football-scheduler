from __future__ import annotations

import pytest

from football_scheduler.models import DayBreak, DaySettings
from football_scheduler.timekeeping import (
    DayTimingError,
    expected_end_time,
    resolve_max_sections,
    section_timings,
)


def test_breaks_shift_later_sections_but_not_match_duration() -> None:
    day = DaySettings(
        id="day2",
        game_duration_minutes=35,
        margin_minutes=10,
        breaks=(DayBreak(after_section=2, duration_minutes=30),),
    )

    timings = section_timings(day, 3)

    assert timings[1].start_time.isoformat(timespec="minutes") == "10:15"
    assert timings[1].break_after_minutes == 30
    assert timings[2].start_time.isoformat(timespec="minutes") == "11:30"
    assert expected_end_time(day, 3).isoformat(timespec="minutes") == "12:05"


def test_end_time_and_section_limit_conflict_is_rejected() -> None:
    day = DaySettings(
        id="day2",
        start_time="09:30",
        game_duration_minutes=35,
        margin_minutes=10,
        max_sections=4,
        end_time="11:30",
    )

    with pytest.raises(DayTimingError) as error:
        resolve_max_sections(day, 8)

    assert error.value.code == "DAY_SECTION_LIMIT_CONFLICT"


def test_unspecified_limit_is_capped_before_midnight() -> None:
    day = DaySettings(
        id="day2",
        start_time="22:30",
        game_duration_minutes=35,
        margin_minutes=10,
    )

    assert resolve_max_sections(day, 20) == 2
