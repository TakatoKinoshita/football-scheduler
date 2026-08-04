#!/usr/bin/env python3
"""ADR-0001・0002の本番利用量を、更新可能な単価で概算する。"""

from __future__ import annotations

import argparse
from dataclasses import asdict

from football_scheduler.costs import DEFAULT_PRICES, SCENARIOS, UnitPrices, estimate_monthly_usd


def main() -> int:
    parser = argparse.ArgumentParser(description="MVP本番構成の月額を無料枠適用前で概算します。")
    parser.add_argument("--usd-jpy", type=float, default=DEFAULT_PRICES.usd_jpy)
    parser.add_argument("--tax-multiplier", type=float, default=DEFAULT_PRICES.tax_multiplier)
    args = parser.parse_args()
    prices = UnitPrices(usd_jpy=args.usd_jpy, tax_multiplier=args.tax_multiplier)

    print("前提単価:")
    for key, value in asdict(prices).items():
        print(f"  {key}: {value}")
    print("\n無料枠適用前の月額概算:")
    for scenario in SCENARIOS:
        usd = estimate_monthly_usd(scenario, prices)
        jpy = usd * prices.usd_jpy * prices.tax_multiplier
        print(
            f"  {scenario.name}: {scenario.generations:,}回、solver {scenario.solver_seconds:g}秒 "
            f"=> ${usd:.3f} / 約{jpy:.0f}円"
        )
    print("Cloudflare Pages Freeと、AWS各サービスの無料枠は0円として別途扱います。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
