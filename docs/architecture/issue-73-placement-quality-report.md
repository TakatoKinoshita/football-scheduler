# Issue #73 placement template quality report

- Final entries: 816
- Optimization targets: 180
- Current baseline SHA-256: `9bd7d61526e5b63f5d7b54af49c1f7851110de49b0882568e4d38039a3b69106`
- Legacy baseline SHA-256: `1216381d99f699af8690bbd578c0a42929184fa06217e136f574f1f5ef34f8b3`
- Target manifest SHA-256: `9d09c406b3ab8002f1d03f66ed762b38300901b0acc8beaf70fd92583a72cc32`
- Catalog SHA-256: `4964fad9b7bcc7e8fa1c45a69026bc94ab6c4d52f5218a0280fc093d5b25ce6f`
- Objective order: `used_sections`, `non_primary_final_max_gap`, `non_primary_final_sum_gap`, `maximum_team_wait_sections`, `team_court_change_count`, `court_usage_difference`

## 結果概要

- 24・32チーム用の全816 entryを`available`として維持し、使用セクション数の最小性を全816件で証明済みのまま維持した。
- current catalogとの比較は改善180件、同等636件、悪化0件だった。
- legacy 30秒solverで現行規則上有効だった223件との比較は改善164件、同等59件、悪化0件だった。
- 最終配置はcurrent 636件、optimizer-v2 180件、legacy 0件を採用した。同値時はcurrentを優先した。
- 8・16チーム用の2 shardはraw SHA-256と内部digestのguardにより変更していない。

## 実行条件と所要時間

- legacyはcommit `2ccf91da34717ae86a21513a43289a2e2b758617`、Python 3.14、OR-Tools 9.15.6755、`random_seed=20260803`、`PYTHONHASHSEED=0`、1 worker、1 key 30秒で全816件を実行した。
- legacyのsolver wall time合計は21849.109秒だった。3 topologyを並列実行したため、これは経過時間ではなく各keyのsolver時間の合計である。
- optimizer-v2のstage wall time合計は11393.468秒だった。3 workerで並列実行したため、これも経過時間ではない。
- すべての候補はcanonical slotへ変換後、現行の審判復元、6目的の再集計、固定配置監査、独立validatorを通過したものだけを比較対象にした。

## Catalog shard digests

| Topology | File | Entries | Internal SHA-256 |
| --- | --- | ---: | --- |
| 2x4 | `placement-p2-s4.json` | 272 | `9050f9844ec034b08dffa9acb74b4d45db454168ade33e5b1c28533e18f0bf2c` |
| 2x8 | `placement-p2-s8.json` | 272 | `1c1e80ede74d3c538a1dd57902f5d22de181a0970b8dbd4ffcf53ddb3ea32055` |
| 3x8 | `placement-p3-s8.json` | 272 | `ffc05d6de33aee8a336aa26e181c0d1fad5c1e101a82b80d13ce682c5fd2dcfd` |
| 2x16 | `placement-p2-s16.json` | 272 | `7efcaefb7d4cad6c9ae8c5b695a1cb9b990c480134c676e116ac9ec17e82d02a` |
| 4x8 | `placement-p4-s8.json` | 272 | `cf83b99ecf85d76d7ec3caddfa6b5c4e8283d101163a8f4ed95a8e77c1ade362` |

## Target distribution

| Topology | Fallback | First differing objective | Targets |
| --- | --- | --- | ---: |
| 3x8 | organizer | non_primary_final_max_gap | 42 |
| 3x8 | organizer | maximum_team_wait_sections | 5 |
| 3x8 | organizer | team_court_change_count | 2 |
| 3x8 | strict | non_primary_final_max_gap | 2 |
| 2x16 | organizer | non_primary_final_max_gap | 44 |
| 2x16 | organizer | maximum_team_wait_sections | 8 |
| 2x16 | organizer | team_court_change_count | 1 |
| 2x16 | strict | team_court_change_count | 1 |
| 4x8 | organizer | non_primary_final_max_gap | 62 |
| 4x8 | organizer | non_primary_final_sum_gap | 3 |
| 4x8 | organizer | maximum_team_wait_sections | 3 |
| 4x8 | organizer | team_court_change_count | 1 |
| 4x8 | strict | non_primary_final_max_gap | 5 |
| 4x8 | strict | team_court_change_count | 1 |

## Candidate source

| Topology | Fallback | Current | Optimizer-v2 | Legacy |
| --- | --- | ---: | ---: | ---: |
| 3x8 | organizer | 87 | 49 | 0 |
| 3x8 | strict | 134 | 2 | 0 |
| 2x16 | organizer | 83 | 53 | 0 |
| 2x16 | strict | 135 | 1 | 0 |
| 4x8 | organizer | 67 | 69 | 0 |
| 4x8 | strict | 130 | 6 | 0 |

## Final candidate comparison

| Topology | Fallback | Baseline | Better | Equal | Worse |
| --- | --- | --- | ---: | ---: | ---: |
| 3x8 | organizer | current | 49 | 87 | 0 |
| 3x8 | organizer | legacy | 63 | 6 | 0 |
| 3x8 | strict | current | 2 | 134 | 0 |
| 3x8 | strict | legacy | 4 | 0 | 0 |
| 2x16 | organizer | current | 53 | 83 | 0 |
| 2x16 | organizer | legacy | 22 | 46 | 0 |
| 2x16 | strict | current | 1 | 135 | 0 |
| 2x16 | strict | legacy | 1 | 1 | 0 |
| 4x8 | organizer | current | 69 | 67 | 0 |
| 4x8 | organizer | legacy | 67 | 5 | 0 |
| 4x8 | strict | current | 6 | 130 | 0 |
| 4x8 | strict | legacy | 7 | 1 | 0 |

## Proof coverage

| Topology | Fallback | Objective | Before | After | Delta |
| --- | --- | --- | ---: | ---: | ---: |
| 3x8 | organizer | used_sections | 136 | 136 | +0 |
| 3x8 | organizer | non_primary_final_max_gap | 20 | 68 | +48 |
| 3x8 | organizer | non_primary_final_sum_gap | 20 | 68 | +48 |
| 3x8 | organizer | maximum_team_wait_sections | 0 | 49 | +49 |
| 3x8 | organizer | team_court_change_count | 0 | 4 | +4 |
| 3x8 | organizer | court_usage_difference | 0 | 0 | +0 |
| 3x8 | strict | used_sections | 136 | 136 | +0 |
| 3x8 | strict | non_primary_final_max_gap | 15 | 17 | +2 |
| 3x8 | strict | non_primary_final_sum_gap | 15 | 17 | +2 |
| 3x8 | strict | maximum_team_wait_sections | 0 | 2 | +2 |
| 3x8 | strict | team_court_change_count | 0 | 0 | +0 |
| 3x8 | strict | court_usage_difference | 0 | 0 | +0 |
| 2x16 | organizer | used_sections | 136 | 136 | +0 |
| 2x16 | organizer | non_primary_final_max_gap | 7 | 51 | +44 |
| 2x16 | organizer | non_primary_final_sum_gap | 7 | 51 | +44 |
| 2x16 | organizer | maximum_team_wait_sections | 0 | 0 | +0 |
| 2x16 | organizer | team_court_change_count | 0 | 0 | +0 |
| 2x16 | organizer | court_usage_difference | 0 | 0 | +0 |
| 2x16 | strict | used_sections | 136 | 136 | +0 |
| 2x16 | strict | non_primary_final_max_gap | 0 | 1 | +1 |
| 2x16 | strict | non_primary_final_sum_gap | 0 | 1 | +1 |
| 2x16 | strict | maximum_team_wait_sections | 0 | 1 | +1 |
| 2x16 | strict | team_court_change_count | 0 | 1 | +1 |
| 2x16 | strict | court_usage_difference | 0 | 1 | +1 |
| 4x8 | organizer | used_sections | 136 | 136 | +0 |
| 4x8 | organizer | non_primary_final_max_gap | 3 | 70 | +67 |
| 4x8 | organizer | non_primary_final_sum_gap | 3 | 70 | +67 |
| 4x8 | organizer | maximum_team_wait_sections | 0 | 64 | +64 |
| 4x8 | organizer | team_court_change_count | 0 | 2 | +2 |
| 4x8 | organizer | court_usage_difference | 0 | 1 | +1 |
| 4x8 | strict | used_sections | 136 | 136 | +0 |
| 4x8 | strict | non_primary_final_max_gap | 0 | 6 | +6 |
| 4x8 | strict | non_primary_final_sum_gap | 0 | 6 | +6 |
| 4x8 | strict | maximum_team_wait_sections | 0 | 6 | +6 |
| 4x8 | strict | team_court_change_count | 0 | 1 | +1 |
| 4x8 | strict | court_usage_difference | 0 | 1 | +1 |

## Legacy status

| Topology | Fallback | Status | Count | Wall time (s) |
| --- | --- | --- | ---: | ---: |
| 3x8 | organizer | available | 69 | 1384.966 |
| 3x8 | organizer | timeout | 0 | 0.000 |
| 3x8 | organizer | infeasible | 67 | 2020.069 |
| 3x8 | organizer | invalid | 0 | 0.000 |
| 3x8 | organizer | error | 0 | 0.000 |
| 3x8 | strict | available | 4 | 99.691 |
| 3x8 | strict | timeout | 3 | 37.476 |
| 3x8 | strict | infeasible | 129 | 3888.713 |
| 3x8 | strict | invalid | 0 | 0.000 |
| 3x8 | strict | error | 0 | 0.000 |
| 2x16 | organizer | available | 68 | 1430.790 |
| 2x16 | organizer | timeout | 3 | 38.977 |
| 2x16 | organizer | infeasible | 65 | 1965.039 |
| 2x16 | organizer | invalid | 0 | 0.000 |
| 2x16 | organizer | error | 0 | 0.000 |
| 2x16 | strict | available | 2 | 31.160 |
| 2x16 | strict | timeout | 43 | 680.124 |
| 2x16 | strict | infeasible | 91 | 2746.968 |
| 2x16 | strict | invalid | 0 | 0.000 |
| 2x16 | strict | error | 0 | 0.000 |
| 4x8 | organizer | available | 72 | 1733.695 |
| 4x8 | organizer | timeout | 0 | 0.000 |
| 4x8 | organizer | infeasible | 64 | 1928.379 |
| 4x8 | organizer | invalid | 0 | 0.000 |
| 4x8 | organizer | error | 0 | 0.000 |
| 4x8 | strict | available | 8 | 186.853 |
| 4x8 | strict | timeout | 11 | 152.634 |
| 4x8 | strict | infeasible | 117 | 3523.574 |
| 4x8 | strict | invalid | 0 | 0.000 |
| 4x8 | strict | error | 0 | 0.000 |

## Legacy diagnostics and timeout reasons

| Topology | Fallback | Status | Reason | Count |
| --- | --- | --- | --- | ---: |
| 2x16 | organizer | available | OPTIMALITY_NOT_PROVEN | 68 |
| 2x16 | organizer | infeasible | ORGANIZER_CAPACITY_INSUFFICIENT | 65 |
| 2x16 | organizer | timeout | TOURNAMENT_SCHEDULE_SEARCH_TIMEOUT | 3 |
| 2x16 | strict | available | OPTIMALITY_NOT_PROVEN | 2 |
| 2x16 | strict | infeasible | TOURNAMENT_REFEREE_UNAVAILABLE | 91 |
| 2x16 | strict | timeout | TOURNAMENT_SCHEDULE_SEARCH_TIMEOUT | 43 |
| 3x8 | organizer | available | OPTIMALITY_NOT_PROVEN | 69 |
| 3x8 | organizer | infeasible | ORGANIZER_CAPACITY_INSUFFICIENT | 67 |
| 3x8 | strict | available | OPTIMALITY_NOT_PROVEN | 4 |
| 3x8 | strict | infeasible | TOURNAMENT_REFEREE_UNAVAILABLE | 129 |
| 3x8 | strict | timeout | TOURNAMENT_SCHEDULE_SEARCH_TIMEOUT | 3 |
| 4x8 | organizer | available | OPTIMALITY_NOT_PROVEN | 72 |
| 4x8 | organizer | infeasible | ORGANIZER_CAPACITY_INSUFFICIENT | 64 |
| 4x8 | strict | available | OPTIMALITY_NOT_PROVEN | 8 |
| 4x8 | strict | infeasible | TOURNAMENT_REFEREE_UNAVAILABLE | 117 |
| 4x8 | strict | timeout | TOURNAMENT_SCHEDULE_SEARCH_TIMEOUT | 11 |

## Optimizer stage checkpoints

| Topology | Fallback | Objective | Status | Proof method | Termination reason | Count | Wall time (s) |
| --- | --- | --- | --- | --- | --- | ---: | ---: |
| 2x16 | organizer | court_usage_difference | FEASIBLE | unproven | feasible_candidate_without_proof | 12 | 155.788 |
| 2x16 | organizer | court_usage_difference | OPTIMAL | unproven | analytic_lower_bound | 5 | 0.000 |
| 2x16 | organizer | court_usage_difference | UNKNOWN | unproven | solver_unknown_or_time_limit | 36 | 407.584 |
| 2x16 | organizer | maximum_team_wait_sections | OPTIMAL | unproven | analytic_lower_bound | 1 | 0.000 |
| 2x16 | organizer | maximum_team_wait_sections | UNKNOWN | unproven | solver_unknown_or_time_limit | 35 | 365.480 |
| 2x16 | organizer | maximum_team_wait_sections | UNKNOWN | unproven | stage_time_limit | 17 | 1.666 |
| 2x16 | organizer | non_primary_final_max_gap | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 44 | 0.000 |
| 2x16 | organizer | non_primary_final_max_gap | OPTIMAL | existing | existing_proof | 3 | 0.000 |
| 2x16 | organizer | non_primary_final_max_gap | UNKNOWN | unproven | solver_unknown_or_time_limit | 6 | 96.871 |
| 2x16 | organizer | non_primary_final_sum_gap | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 44 | 0.000 |
| 2x16 | organizer | non_primary_final_sum_gap | OPTIMAL | existing | existing_proof | 3 | 0.000 |
| 2x16 | organizer | non_primary_final_sum_gap | UNKNOWN | unproven | two_pool_gap_identity_after_unproven_max | 6 | 0.000 |
| 2x16 | organizer | team_court_change_count | FEASIBLE | unproven | feasible_candidate_without_proof | 12 | 155.487 |
| 2x16 | organizer | team_court_change_count | UNKNOWN | unproven | solver_unknown_or_time_limit | 41 | 463.327 |
| 2x16 | organizer | used_sections | OPTIMAL | existing | existing_proof | 53 | 0.000 |
| 2x16 | strict | court_usage_difference | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 1 | 0.000 |
| 2x16 | strict | maximum_team_wait_sections | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 1 | 0.000 |
| 2x16 | strict | non_primary_final_max_gap | OPTIMAL | section_relaxation_exact_completion | section_relaxation_exact_completion | 1 | 8.212 |
| 2x16 | strict | non_primary_final_sum_gap | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 1 | 0.000 |
| 2x16 | strict | team_court_change_count | OPTIMAL | full_exact | optimality_proven | 1 | 14.175 |
| 2x16 | strict | used_sections | OPTIMAL | existing | existing_proof | 1 | 0.000 |
| 3x8 | organizer | court_usage_difference | FEASIBLE | unproven | feasible_candidate_without_proof | 43 | 732.281 |
| 3x8 | organizer | court_usage_difference | OPTIMAL | unproven | analytic_lower_bound | 3 | 0.000 |
| 3x8 | organizer | court_usage_difference | UNKNOWN | unproven | solver_unknown_or_time_limit | 3 | 41.769 |
| 3x8 | organizer | maximum_team_wait_sections | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 4 | 0.000 |
| 3x8 | organizer | maximum_team_wait_sections | OPTIMAL | full_exact | optimality_proven | 20 | 305.502 |
| 3x8 | organizer | maximum_team_wait_sections | OPTIMAL | section_relaxation_exact_completion | section_relaxation_exact_completion | 25 | 231.571 |
| 3x8 | organizer | non_primary_final_max_gap | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 42 | 0.000 |
| 3x8 | organizer | non_primary_final_max_gap | OPTIMAL | existing | existing_proof | 1 | 0.000 |
| 3x8 | organizer | non_primary_final_max_gap | OPTIMAL | section_relaxation_exact_completion | section_relaxation_exact_completion | 6 | 59.458 |
| 3x8 | organizer | non_primary_final_sum_gap | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 42 | 0.000 |
| 3x8 | organizer | non_primary_final_sum_gap | OPTIMAL | existing | existing_proof | 1 | 0.000 |
| 3x8 | organizer | non_primary_final_sum_gap | OPTIMAL | full_exact | optimality_proven | 1 | 12.992 |
| 3x8 | organizer | non_primary_final_sum_gap | OPTIMAL | section_relaxation_exact_completion | section_relaxation_exact_completion | 5 | 38.819 |
| 3x8 | organizer | team_court_change_count | FEASIBLE | unproven | feasible_candidate_without_proof | 45 | 2317.076 |
| 3x8 | organizer | team_court_change_count | OPTIMAL | full_exact | optimality_proven | 4 | 16.807 |
| 3x8 | organizer | used_sections | OPTIMAL | existing | existing_proof | 49 | 0.000 |
| 3x8 | strict | court_usage_difference | OPTIMAL | unproven | analytic_lower_bound | 2 | 0.000 |
| 3x8 | strict | maximum_team_wait_sections | OPTIMAL | section_relaxation_exact_completion | section_relaxation_exact_completion | 2 | 9.837 |
| 3x8 | strict | non_primary_final_max_gap | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 2 | 0.000 |
| 3x8 | strict | non_primary_final_sum_gap | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 2 | 0.000 |
| 3x8 | strict | team_court_change_count | FEASIBLE | unproven | feasible_candidate_without_proof | 2 | 117.773 |
| 3x8 | strict | used_sections | OPTIMAL | existing | existing_proof | 2 | 0.000 |
| 4x8 | organizer | court_usage_difference | FEASIBLE | unproven | feasible_candidate_without_proof | 55 | 784.638 |
| 4x8 | organizer | court_usage_difference | INFEASIBLE | unproven | infeasible | 2 | 3.123 |
| 4x8 | organizer | court_usage_difference | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 1 | 0.000 |
| 4x8 | organizer | court_usage_difference | OPTIMAL | unproven | analytic_lower_bound | 8 | 0.000 |
| 4x8 | organizer | court_usage_difference | UNKNOWN | unproven | solver_unknown_or_time_limit | 3 | 41.822 |
| 4x8 | organizer | maximum_team_wait_sections | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 1 | 0.000 |
| 4x8 | organizer | maximum_team_wait_sections | OPTIMAL | full_exact | optimality_proven | 60 | 1076.506 |
| 4x8 | organizer | maximum_team_wait_sections | OPTIMAL | section_relaxation_exact_completion | section_relaxation_exact_completion | 3 | 35.962 |
| 4x8 | organizer | maximum_team_wait_sections | UNKNOWN | unproven | solver_unknown_or_time_limit | 5 | 127.842 |
| 4x8 | organizer | non_primary_final_max_gap | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 56 | 0.000 |
| 4x8 | organizer | non_primary_final_max_gap | OPTIMAL | existing | existing_proof | 2 | 0.000 |
| 4x8 | organizer | non_primary_final_max_gap | OPTIMAL | full_exact | optimality_proven | 10 | 164.338 |
| 4x8 | organizer | non_primary_final_max_gap | OPTIMAL | section_relaxation_exact_completion | section_relaxation_exact_completion | 1 | 6.914 |
| 4x8 | organizer | non_primary_final_sum_gap | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 56 | 0.000 |
| 4x8 | organizer | non_primary_final_sum_gap | OPTIMAL | existing | existing_proof | 2 | 0.000 |
| 4x8 | organizer | non_primary_final_sum_gap | OPTIMAL | full_exact | optimality_proven | 7 | 118.700 |
| 4x8 | organizer | non_primary_final_sum_gap | OPTIMAL | section_relaxation_exact_completion | section_relaxation_exact_completion | 4 | 45.416 |
| 4x8 | organizer | team_court_change_count | FEASIBLE | unproven | feasible_candidate_without_proof | 64 | 2868.936 |
| 4x8 | organizer | team_court_change_count | OPTIMAL | full_exact | optimality_proven | 2 | 33.933 |
| 4x8 | organizer | team_court_change_count | UNKNOWN | unproven | solver_unknown_or_time_limit | 3 | 138.673 |
| 4x8 | organizer | used_sections | OPTIMAL | existing | existing_proof | 69 | 0.000 |
| 4x8 | strict | court_usage_difference | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 1 | 0.000 |
| 4x8 | strict | court_usage_difference | OPTIMAL | unproven | analytic_lower_bound | 5 | 0.000 |
| 4x8 | strict | maximum_team_wait_sections | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 1 | 0.000 |
| 4x8 | strict | maximum_team_wait_sections | OPTIMAL | full_exact | optimality_proven | 3 | 45.757 |
| 4x8 | strict | maximum_team_wait_sections | OPTIMAL | section_relaxation_exact_completion | section_relaxation_exact_completion | 2 | 21.311 |
| 4x8 | strict | non_primary_final_max_gap | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 4 | 0.000 |
| 4x8 | strict | non_primary_final_max_gap | OPTIMAL | full_exact | optimality_proven | 1 | 15.610 |
| 4x8 | strict | non_primary_final_max_gap | OPTIMAL | section_relaxation_exact_completion | section_relaxation_exact_completion | 1 | 3.849 |
| 4x8 | strict | non_primary_final_sum_gap | OPTIMAL | analytic_lower_bound | analytic_lower_bound | 4 | 0.000 |
| 4x8 | strict | non_primary_final_sum_gap | OPTIMAL | full_exact | optimality_proven | 1 | 16.399 |
| 4x8 | strict | non_primary_final_sum_gap | OPTIMAL | section_relaxation_exact_completion | section_relaxation_exact_completion | 1 | 3.879 |
| 4x8 | strict | team_court_change_count | FEASIBLE | unproven | feasible_candidate_without_proof | 5 | 281.669 |
| 4x8 | strict | team_court_change_count | OPTIMAL | full_exact | optimality_proven | 1 | 5.713 |
| 4x8 | strict | used_sections | OPTIMAL | existing | existing_proof | 6 | 0.000 |
