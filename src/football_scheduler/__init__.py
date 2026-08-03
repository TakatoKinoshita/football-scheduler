"""地域サッカー大会スケジューラの公開API。"""

from football_scheduler.fixtures import make_representative_request, make_smoke_request
from football_scheduler.models import ScheduleRequest, ScheduleResult, SolverStatus
from football_scheduler.solver import solve_schedule

__all__ = [
    "ScheduleRequest",
    "ScheduleResult",
    "SolverStatus",
    "make_representative_request",
    "make_smoke_request",
    "solve_schedule",
]

__version__ = "0.1.0"
