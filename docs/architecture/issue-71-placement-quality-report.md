# Issue #71 placement template quality report

- Final entries: 544
- Current baseline SHA-256: `98568c54f96d9a303835da23c0a0803ee8eef0895e4eb1f9f28ac240868406a0`
- Legacy baseline SHA-256: `0c1b8e2d6549f2e6f32c8c4c737f49358bfbf3031c3786acccd9177d397cc13e`
- Objective order: `used_sections`, `non_primary_final_max_gap`, `non_primary_final_sum_gap`, `maximum_team_wait_sections`, `team_court_change_count`, `court_usage_difference`

## 結果概要

- 8・16チーム用の全544 entryを`available`として維持し、証明済み最小セクション数を変更しなかった。
- current catalogとの比較は改善537件、同等7件、悪化0件だった。
- legacy 30秒solverで現行規則上有効だった209件との比較は改善85件、同等124件、悪化0件だった。残る335件はlegacy側で`INFEASIBLE`だった。
- 決勝gap 2目的の証明は221件から535件、最大待ち時間までの証明は0件から535件へ増えた。コート移動まで318件、全6目的は0件から316件へ増えた。
- 2x4は全272件で6目的すべてを証明した。2x8は決勝gapと最大待ち時間まで535件中263件、コート移動まで46件、全6目的44件を証明した。
- 未証明の目的が残るentryでも、current・legacy・newの独立検証済み候補から辞書式に最良の配置を採用した。`FEASIBLE`は制約違反ではなく、最適性の証明が未完了であることだけを表す。

## 実行条件と所要時間

- legacyはcommit `2ccf91da34717ae86a21513a43289a2e2b758617`、Python 3.14、OR-Tools 9.15.6755、`random_seed=20260803`、`PYTHONHASHSEED=0`、1 worker、1 key 30秒で全544件を実行した。
- legacyのsolver wall time合計は11,942.055秒だった。6 workerで並列実行したため、これは経過時間ではなく各keyのsolver時間の合計である。
- 新optimizerは2x4を既定上限840秒、2x8の先行37件を840秒、残りを60秒の段階上限で実行した。現行モデル導入前に完了していた2x8の7件は退避し、60秒上限で再実行した。
- 新optimizerのstage wall time合計は2x4が655.607秒、2x8が31,161.444秒、合計31,817.051秒だった。4 workerで並列実行したため、これも経過時間ではない。CLIの既定上限840秒は変更していない。
- すべての候補はcanonical slotへ変換後、現行の審判復元、6目的の再集計、固定配置監査、独立validatorを通過したものだけを比較対象にした。
- 24・32チーム用3 shardのraw SHA-256は、それぞれ`f05dc54dcc148e6a3dab6c75867dad84e8be6706329aae2d5ffa2c0ed8b67d38`、`4e44e1485c054a4de93cb902c13b439a86a4c6ef6b707ab5eba540cf3c1ab083`、`9b4ebce9d4ab53110c10d59f5e8f59aed474d0ca6a32c29d5cd72f6db59c348a`のまま維持した。

## Proof coverage

| Topology | Fallback | Objective | Before | After | Delta |
| --- | --- | --- | ---: | ---: | ---: |
| 2x4 | organizer | used_sections | 136 | 136 | +0 |
| 2x4 | organizer | non_primary_final_max_gap | 109 | 136 | +27 |
| 2x4 | organizer | non_primary_final_sum_gap | 109 | 136 | +27 |
| 2x4 | organizer | maximum_team_wait_sections | 0 | 136 | +136 |
| 2x4 | organizer | team_court_change_count | 0 | 136 | +136 |
| 2x4 | organizer | court_usage_difference | 0 | 136 | +136 |
| 2x4 | strict | used_sections | 136 | 136 | +0 |
| 2x4 | strict | non_primary_final_max_gap | 1 | 136 | +135 |
| 2x4 | strict | non_primary_final_sum_gap | 1 | 136 | +135 |
| 2x4 | strict | maximum_team_wait_sections | 0 | 136 | +136 |
| 2x4 | strict | team_court_change_count | 0 | 136 | +136 |
| 2x4 | strict | court_usage_difference | 0 | 136 | +136 |
| 2x8 | organizer | used_sections | 136 | 136 | +0 |
| 2x8 | organizer | non_primary_final_max_gap | 92 | 136 | +44 |
| 2x8 | organizer | non_primary_final_sum_gap | 92 | 136 | +44 |
| 2x8 | organizer | maximum_team_wait_sections | 0 | 136 | +136 |
| 2x8 | organizer | team_court_change_count | 0 | 7 | +7 |
| 2x8 | organizer | court_usage_difference | 0 | 7 | +7 |
| 2x8 | strict | used_sections | 136 | 136 | +0 |
| 2x8 | strict | non_primary_final_max_gap | 19 | 127 | +108 |
| 2x8 | strict | non_primary_final_sum_gap | 19 | 127 | +108 |
| 2x8 | strict | maximum_team_wait_sections | 0 | 127 | +127 |
| 2x8 | strict | team_court_change_count | 0 | 39 | +39 |
| 2x8 | strict | court_usage_difference | 0 | 37 | +37 |

## Final candidate comparison

| Topology | Fallback | Baseline | Better | Equal | Worse |
| --- | --- | --- | ---: | ---: | ---: |
| 2x4 | organizer | current | 135 | 1 | 0 |
| 2x4 | organizer | legacy | 1 | 108 | 0 |
| 2x4 | strict | current | 130 | 6 | 0 |
| 2x4 | strict | legacy | 0 | 3 | 0 |
| 2x8 | organizer | current | 136 | 0 | 0 |
| 2x8 | organizer | legacy | 82 | 11 | 0 |
| 2x8 | strict | current | 136 | 0 | 0 |
| 2x8 | strict | legacy | 2 | 2 | 0 |

## Legacy baseline status

| Topology | Fallback | Status | Count | Wall time (s) |
| --- | --- | --- | ---: | ---: |
| 2x4 | organizer | available | 109 | 173.472 |
| 2x4 | organizer | timeout | 0 | 0.000 |
| 2x4 | organizer | infeasible | 27 | 781.783 |
| 2x4 | organizer | invalid | 0 | 0.000 |
| 2x4 | organizer | error | 0 | 0.000 |
| 2x4 | strict | available | 3 | 3.937 |
| 2x4 | strict | timeout | 0 | 0.000 |
| 2x4 | strict | infeasible | 133 | 3784.537 |
| 2x4 | strict | invalid | 0 | 0.000 |
| 2x4 | strict | error | 0 | 0.000 |
| 2x8 | organizer | available | 93 | 1872.192 |
| 2x8 | organizer | timeout | 0 | 0.000 |
| 2x8 | organizer | infeasible | 43 | 1294.089 |
| 2x8 | organizer | invalid | 0 | 0.000 |
| 2x8 | organizer | error | 0 | 0.000 |
| 2x8 | strict | available | 4 | 60.084 |
| 2x8 | strict | timeout | 0 | 0.000 |
| 2x8 | strict | infeasible | 132 | 3971.961 |
| 2x8 | strict | invalid | 0 | 0.000 |
| 2x8 | strict | error | 0 | 0.000 |

## Optimizer stage checkpoints

| Topology | Fallback | Objective | Status | Proof method | Count | Wall time (s) |
| --- | --- | --- | --- | --- | ---: | ---: |
| 2x4 | organizer | court_usage_difference | OPTIMAL | analytic_lower_bound | 5 | 0.000 |
| 2x4 | organizer | court_usage_difference | OPTIMAL | full_exact | 131 | 116.772 |
| 2x4 | organizer | maximum_team_wait_sections | OPTIMAL | analytic_lower_bound | 1 | 0.000 |
| 2x4 | organizer | maximum_team_wait_sections | OPTIMAL | section_relaxation_exact_completion | 135 | 92.447 |
| 2x4 | organizer | non_primary_final_max_gap | OPTIMAL | existing | 109 | 0.000 |
| 2x4 | organizer | non_primary_final_max_gap | OPTIMAL | section_relaxation_exact_completion | 27 | 17.047 |
| 2x4 | organizer | non_primary_final_sum_gap | OPTIMAL | existing | 109 | 0.000 |
| 2x4 | organizer | non_primary_final_sum_gap | OPTIMAL | section_relaxation_exact_completion | 27 | 0.000 |
| 2x4 | organizer | team_court_change_count | OPTIMAL | analytic_lower_bound | 1 | 0.000 |
| 2x4 | organizer | team_court_change_count | OPTIMAL | full_exact | 135 | 161.614 |
| 2x4 | organizer | used_sections | OPTIMAL | existing | 136 | 0.000 |
| 2x4 | strict | court_usage_difference | OPTIMAL | analytic_lower_bound | 2 | 0.000 |
| 2x4 | strict | court_usage_difference | OPTIMAL | full_exact | 134 | 67.219 |
| 2x4 | strict | maximum_team_wait_sections | OPTIMAL | analytic_lower_bound | 1 | 0.000 |
| 2x4 | strict | maximum_team_wait_sections | OPTIMAL | section_relaxation_exact_completion | 135 | 63.882 |
| 2x4 | strict | non_primary_final_max_gap | OPTIMAL | existing | 1 | 0.000 |
| 2x4 | strict | non_primary_final_max_gap | OPTIMAL | section_relaxation_exact_completion | 135 | 62.801 |
| 2x4 | strict | non_primary_final_sum_gap | OPTIMAL | existing | 1 | 0.000 |
| 2x4 | strict | non_primary_final_sum_gap | OPTIMAL | section_relaxation_exact_completion | 135 | 0.000 |
| 2x4 | strict | team_court_change_count | OPTIMAL | analytic_lower_bound | 1 | 0.000 |
| 2x4 | strict | team_court_change_count | OPTIMAL | full_exact | 135 | 73.824 |
| 2x4 | strict | used_sections | OPTIMAL | existing | 136 | 0.000 |
| 2x8 | organizer | court_usage_difference | FEASIBLE | unproven | 128 | 5382.144 |
| 2x8 | organizer | court_usage_difference | OPTIMAL | analytic_lower_bound | 5 | 0.000 |
| 2x8 | organizer | court_usage_difference | OPTIMAL | full_exact | 2 | 431.296 |
| 2x8 | organizer | court_usage_difference | OPTIMAL | unproven | 1 | 0.000 |
| 2x8 | organizer | maximum_team_wait_sections | OPTIMAL | analytic_lower_bound | 1 | 0.000 |
| 2x8 | organizer | maximum_team_wait_sections | OPTIMAL | full_exact | 11 | 207.610 |
| 2x8 | organizer | maximum_team_wait_sections | OPTIMAL | section_relaxation_exact_completion | 124 | 932.761 |
| 2x8 | organizer | non_primary_final_max_gap | OPTIMAL | analytic_lower_bound | 1 | 0.000 |
| 2x8 | organizer | non_primary_final_max_gap | OPTIMAL | existing | 92 | 0.000 |
| 2x8 | organizer | non_primary_final_max_gap | OPTIMAL | full_exact | 8 | 162.368 |
| 2x8 | organizer | non_primary_final_max_gap | OPTIMAL | section_relaxation_exact_completion | 35 | 264.471 |
| 2x8 | organizer | non_primary_final_sum_gap | OPTIMAL | analytic_lower_bound | 1 | 0.000 |
| 2x8 | organizer | non_primary_final_sum_gap | OPTIMAL | existing | 92 | 0.000 |
| 2x8 | organizer | non_primary_final_sum_gap | OPTIMAL | full_exact | 8 | 0.000 |
| 2x8 | organizer | non_primary_final_sum_gap | OPTIMAL | section_relaxation_exact_completion | 35 | 0.000 |
| 2x8 | organizer | team_court_change_count | FEASIBLE | unproven | 129 | 13739.386 |
| 2x8 | organizer | team_court_change_count | OPTIMAL | analytic_lower_bound | 1 | 0.000 |
| 2x8 | organizer | team_court_change_count | OPTIMAL | full_exact | 6 | 186.382 |
| 2x8 | organizer | used_sections | OPTIMAL | existing | 136 | 0.000 |
| 2x8 | strict | court_usage_difference | FEASIBLE | unproven | 98 | 867.267 |
| 2x8 | strict | court_usage_difference | OPTIMAL | analytic_lower_bound | 3 | 0.000 |
| 2x8 | strict | court_usage_difference | OPTIMAL | full_exact | 34 | 426.557 |
| 2x8 | strict | court_usage_difference | OPTIMAL | unproven | 1 | 0.000 |
| 2x8 | strict | maximum_team_wait_sections | FEASIBLE | unproven | 9 | 42.718 |
| 2x8 | strict | maximum_team_wait_sections | OPTIMAL | analytic_lower_bound | 1 | 0.000 |
| 2x8 | strict | maximum_team_wait_sections | OPTIMAL | full_exact | 7 | 26.305 |
| 2x8 | strict | maximum_team_wait_sections | OPTIMAL | section_relaxation_exact_completion | 119 | 633.486 |
| 2x8 | strict | non_primary_final_max_gap | FEASIBLE | unproven | 9 | 404.612 |
| 2x8 | strict | non_primary_final_max_gap | OPTIMAL | analytic_lower_bound | 15 | 0.000 |
| 2x8 | strict | non_primary_final_max_gap | OPTIMAL | existing | 19 | 0.000 |
| 2x8 | strict | non_primary_final_max_gap | OPTIMAL | full_exact | 20 | 431.348 |
| 2x8 | strict | non_primary_final_max_gap | OPTIMAL | section_relaxation_exact_completion | 73 | 397.937 |
| 2x8 | strict | non_primary_final_sum_gap | FEASIBLE | unproven | 9 | 0.000 |
| 2x8 | strict | non_primary_final_sum_gap | OPTIMAL | analytic_lower_bound | 15 | 0.000 |
| 2x8 | strict | non_primary_final_sum_gap | OPTIMAL | existing | 19 | 0.000 |
| 2x8 | strict | non_primary_final_sum_gap | OPTIMAL | full_exact | 20 | 0.000 |
| 2x8 | strict | non_primary_final_sum_gap | OPTIMAL | section_relaxation_exact_completion | 73 | 0.000 |
| 2x8 | strict | team_court_change_count | FEASIBLE | unproven | 97 | 5329.029 |
| 2x8 | strict | team_court_change_count | OPTIMAL | analytic_lower_bound | 1 | 0.000 |
| 2x8 | strict | team_court_change_count | OPTIMAL | full_exact | 38 | 1295.769 |
| 2x8 | strict | used_sections | OPTIMAL | existing | 136 | 0.000 |
