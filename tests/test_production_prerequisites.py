from football_scheduler.production_checks import evaluate


def test_paid_account_with_capacity_passes_cloudfront_checks() -> None:
    checks = evaluate(
        {"accountPlanType": "PAID", "accountPlanStatus": "ACTIVE"},
        {"subscriptionSummaries": []},
        {"AccountLimit": {"ConcurrentExecutions": 1000}},
        hosting="cloudfront",
    )
    assert [check.level for check in checks] == ["合格", "合格", "合格", "要確認"]


def test_free_tier_plan_and_minimum_lambda_quota_fail() -> None:
    checks = evaluate(
        {"accountPlanType": "FREE", "accountPlanStatus": "ACTIVE"},
        {
            "subscriptionSummaries": [
                {"planFamily": "CloudFront", "planTier": "FREE", "status": "ACTIVE"}
                for _ in range(3)
            ]
        },
        {"AccountLimit": {"ConcurrentExecutions": 10}},
        hosting="cloudfront",
    )
    assert [check.level for check in checks].count("不合格") == 3


def test_cloudflare_pages_accepts_free_aws_account_but_not_low_lambda_quota() -> None:
    checks = evaluate(
        {"accountPlanType": "FREE", "accountPlanStatus": "ACTIVE"},
        {},
        {"AccountLimit": {"ConcurrentExecutions": 10}},
        hosting="cloudflare-pages",
    )

    assert [check.level for check in checks] == ["合格", "不合格", "要確認"]
    assert "CloudFront定額プランへの加入は不要" in checks[0].message
    assert "16以上" in checks[1].message
