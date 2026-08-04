from football_scheduler.costs import SCENARIOS, UnitPrices, estimate_monthly_usd


def test_all_documented_scenarios_remain_below_500_yen() -> None:
    prices = UnitPrices()
    for scenario in SCENARIOS:
        yen = estimate_monthly_usd(scenario, prices) * prices.usd_jpy * prices.tax_multiplier
        assert yen < 500


def test_abuse_scenario_is_more_expensive_than_busy_scenario() -> None:
    estimates = [estimate_monthly_usd(scenario) for scenario in SCENARIOS]
    assert estimates[2] > estimates[1] > estimates[0]
