import copy

import pytest

from scripts.check_production_change_set import render_summary, validate_change_set

_RELEASE_ID = "a" * 40
_CHANGE_SET_ID = (
    "arn:aws:cloudformation:us-east-1:123456789012:changeSet/samcli-deploy/example-change-set-id"
)


def _document() -> dict[str, object]:
    return {
        "ChangeSetId": _CHANGE_SET_ID,
        "StackName": "football-scheduler-production",
        "Status": "CREATE_COMPLETE",
        "ExecutionStatus": "AVAILABLE",
        "Parameters": [
            {"ParameterKey": "ReleaseId", "ParameterValue": _RELEASE_ID},
            {"ParameterKey": "TurnstileSecretKey", "ParameterValue": "do-not-log-this"},
        ],
        "Changes": [
            {
                "Type": "Resource",
                "ResourceChange": {
                    "Action": "Add",
                    "LogicalResourceId": "SolverFunction",
                    "ResourceType": "AWS::Lambda::Function",
                },
            }
        ],
    }


def test_validate_change_set_accepts_executable_initial_plan() -> None:
    changes = validate_change_set(
        _document(),
        stack_name="football-scheduler-production",
        release_id=_RELEASE_ID,
        region="us-east-1",
        require_add_only=True,
    )

    assert changes == [
        {
            "Action": "Add",
            "LogicalId": "SolverFunction",
            "Type": "AWS::Lambda::Function",
            "Replacement": "-",
        }
    ]


@pytest.mark.parametrize(
    ("key", "value", "message"),
    [
        ("StackName", "other-stack", "本番stack"),
        ("Status", "CREATE_PENDING", "作成が完了"),
        ("ExecutionStatus", "OBSOLETE", "実行可能"),
    ],
)
def test_validate_change_set_rejects_wrong_target_or_state(
    key: str, value: str, message: str
) -> None:
    document = _document()
    document[key] = value

    with pytest.raises(ValueError, match=message):
        validate_change_set(
            document,
            stack_name="football-scheduler-production",
            release_id=_RELEASE_ID,
            region="us-east-1",
        )


def test_validate_change_set_rejects_wrong_region() -> None:
    document = _document()
    document["ChangeSetId"] = _CHANGE_SET_ID.replace("us-east-1", "ap-northeast-1")

    with pytest.raises(ValueError, match="検証region"):
        validate_change_set(
            document,
            stack_name="football-scheduler-production",
            release_id=_RELEASE_ID,
            region="us-east-1",
        )


def test_validate_change_set_rejects_wrong_release() -> None:
    with pytest.raises(ValueError, match="commit SHA"):
        validate_change_set(
            _document(),
            stack_name="football-scheduler-production",
            release_id="b" * 40,
            region="us-east-1",
        )


@pytest.mark.parametrize(("action", "replacement"), [("Modify", "False"), ("Add", "True")])
def test_initial_plan_rejects_non_add_or_replacement(action: str, replacement: str) -> None:
    document = copy.deepcopy(_document())
    resource = document["Changes"][0]["ResourceChange"]  # type: ignore[index]
    resource["Action"] = action  # type: ignore[index]
    resource["Replacement"] = replacement  # type: ignore[index]

    with pytest.raises(ValueError, match=r"Add以外|置換"):
        validate_change_set(
            document,
            stack_name="football-scheduler-production",
            release_id=_RELEASE_ID,
            region="us-east-1",
            require_add_only=True,
        )


def test_summary_does_not_include_secret_parameters() -> None:
    document = _document()
    changes = validate_change_set(
        document,
        stack_name="football-scheduler-production",
        release_id=_RELEASE_ID,
        region="us-east-1",
    )

    summary = render_summary(_CHANGE_SET_ID, _RELEASE_ID, changes)

    assert "Add" in summary
    assert "SolverFunction" in summary
    assert "AWS::Lambda::Function" in summary
    assert "do-not-log-this" not in summary
    assert "TurnstileSecretKey" not in summary
