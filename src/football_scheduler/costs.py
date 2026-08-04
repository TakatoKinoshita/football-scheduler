"""MVP本番構成の更新可能な費用モデル。"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class UnitPrices:
    lambda_gb_second_usd: float = 0.0000166667
    lambda_request_usd: float = 0.20 / 1_000_000
    rest_api_request_usd: float = 3.50 / 1_000_000
    ecr_gb_month_usd: float = 0.10
    cloudwatch_ingest_gb_usd: float = 0.50
    usd_jpy: float = 160.0
    tax_multiplier: float = 1.10


@dataclass(frozen=True)
class Scenario:
    name: str
    generations: int
    solver_seconds: float


SCENARIOS = (
    Scenario("通常", 100, 1.975),
    Scenario("繁忙", 1_000, 1.975),
    Scenario("濫用上限", 3_000, 20.0),
)
DEFAULT_PRICES = UnitPrices()


def estimate_monthly_usd(scenario: Scenario, prices: UnitPrices = DEFAULT_PRICES) -> float:
    solver_compute = (
        scenario.generations * 2.0 * scenario.solver_seconds * prices.lambda_gb_second_usd
    )
    authorizer_compute = scenario.generations * 0.128 * 0.1 * prices.lambda_gb_second_usd
    lambda_requests = scenario.generations * 2 * prices.lambda_request_usd
    api_requests = scenario.generations * prices.rest_api_request_usd
    ecr_storage = (276.12 / 1024) * prices.ecr_gb_month_usd
    log_ingestion = (
        scenario.generations * 2 * 2_000 / 1_000_000_000 * prices.cloudwatch_ingest_gb_usd
    )
    return sum(
        (
            solver_compute,
            authorizer_compute,
            lambda_requests,
            api_requests,
            ecr_storage,
            log_ingestion,
        )
    )
