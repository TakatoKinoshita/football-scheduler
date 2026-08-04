"""本番デプロイ前に評価するAWS account条件。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

MINIMUM_CONCURRENT_EXECUTIONS = 16


@dataclass(frozen=True)
class Check:
    level: str
    message: str


def evaluate(
    free_tier: dict[str, Any],
    subscriptions: dict[str, Any],
    lambda_settings: dict[str, Any],
    *,
    hosting: str = "cloudflare-pages",
) -> list[Check]:
    checks: list[Check] = []
    plan_type = free_tier.get("accountPlanType")
    if hosting == "cloudflare-pages":
        if plan_type in {"PAID", "FREE"}:
            checks.append(
                Check(
                    "合格",
                    f"AWS account planは{plan_type}です。静的配信はCloudflare Pagesを使うため、"
                    "CloudFront定額プランへの加入は不要です。",
                )
            )
        else:
            checks.append(Check("要確認", "AWS account planの種類を判定できませんでした。"))
    elif hosting == "cloudfront":
        if plan_type == "PAID":
            checks.append(Check("合格", "AWS account planはPAIDです。"))
        elif plan_type == "FREE":
            checks.append(
                Check(
                    "不合格",
                    "AWS Free Tier account planの利用中はCloudFront定額プランへ加入できません。",
                )
            )
        else:
            checks.append(Check("要確認", "AWS account planの種類を判定できませんでした。"))
    else:
        raise ValueError(f"未対応の静的配信方式です: {hosting}")

    if hosting == "cloudfront":
        summaries = subscriptions.get("subscriptionSummaries")
        free_cloudfront = 0
        if isinstance(summaries, list):
            free_cloudfront = sum(
                1
                for item in summaries
                if isinstance(item, dict)
                and item.get("planFamily") == "CloudFront"
                and item.get("planTier") == "FREE"
                and item.get("status") in {"ACTIVE", "PENDING_APPROVAL", "SYNC_IN_PROGRESS"}
            )
        checks.append(
            Check(
                "合格" if free_cloudfront < 3 else "不合格",
                f"CloudFront Free plan使用数は{free_cloudfront}/3です。",
            )
        )

    account_limit = lambda_settings.get("AccountLimit")
    concurrency = (
        account_limit.get("ConcurrentExecutions") if isinstance(account_limit, dict) else None
    )
    if isinstance(concurrency, int) and concurrency >= MINIMUM_CONCURRENT_EXECUTIONS:
        checks.append(
            Check("合格", f"Lambda account同時実行quotaは{concurrency}です。必要値は16以上です。")
        )
    else:
        checks.append(
            Check(
                "不合格",
                f"Lambda account同時実行quotaは{concurrency!s}です。"
                "solverとauthorizerへ各3を予約し、10を未予約で残すには16以上が必要です。",
            )
        )
    if hosting == "cloudfront":
        checks.append(
            Check(
                "要確認",
                "直近利用量・distribution設定による適格性は、AWSコンソールの"
                "CloudFront plan選択画面で最終確認してください。",
            )
        )
    else:
        checks.append(
            Check(
                "要確認",
                "Cloudflare Pages project、Pages Functionsのsecret、fail closed設定は"
                "Cloudflare dashboardで最終確認してください。",
            )
        )
    return checks
