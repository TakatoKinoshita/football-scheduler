# トーナメント論理配置契約

## 目的

`TournamentPoolPlan.logical_layout`は、完全順位決定トーナメントの対戦を変更せず、表示処理が試合と参加枠を安定した順序で配置するための契約である。座標、用紙寸法、垂直・水平などの見た目は含めない。

表示上の対称性より、シード、不戦通過、同一ブロック初戦の回避、同一ブロック再戦の遅延を優先する。勝者側と敗者側の組合せ順が異なる場合、生成器は対戦を並べ替えず、その差を`branch_alignments`へ記録する。

## 対象と互換性

- 2のべき乗かつ2チーム以上の新規生成結果には`logical_layout`を設定する。
- 0・1チームおよび2のべき乗でない参加数では`logical_layout`を`null`とする。
- `logical_layout`がない既存の`schema_version: "0.1.0"`も受理する。
- 本契約は後方互換な追加情報であるため、トーナメント全体のスキーマバージョンは変更しない。

## JSON形式

```json
{
  "logical_layout": {
    "layout_version": "1",
    "symmetry": "permuted",
    "opening_entry_order": [],
    "match_positions": [
      {
        "match_id": "UT-RANK-1-16-M1",
        "rank_range": [1, 16],
        "order": 1
      }
    ],
    "branch_alignments": [
      {
        "rank_range": [1, 16],
        "status": "permuted",
        "winner_source_order": [
          "UT-RANK-1-16-M1",
          "UT-RANK-1-16-M5",
          "UT-RANK-1-16-M2",
          "UT-RANK-1-16-M6",
          "UT-RANK-1-16-M3",
          "UT-RANK-1-16-M4",
          "UT-RANK-1-16-M7",
          "UT-RANK-1-16-M8"
        ],
        "loser_source_order": [
          "UT-RANK-1-16-M1",
          "UT-RANK-1-16-M6",
          "UT-RANK-1-16-M2",
          "UT-RANK-1-16-M8",
          "UT-RANK-1-16-M3",
          "UT-RANK-1-16-M5",
          "UT-RANK-1-16-M7",
          "UT-RANK-1-16-M4"
        ],
        "loser_to_winner_permutation": [1, 4, 3, 8, 5, 2, 7, 6],
        "diagnostic_code": "OUTCOME_BRANCH_ORDER_DIFFERS"
      }
    ]
  }
}
```

## 順序の定義

- `opening_entry_order`は、全参加者を含む最初の順位帯の試合を`match_positions.order`順に並べ、各試合の`home`、`away`の順で展開する。
- `match_positions.order`は、同じ`rank_range`内で1から連続する。
- `winner_source_order`と`loser_source_order`は、子順位帯の試合を論理順に並べ、各試合の`home`、`away`が参照する親試合IDを展開する。隣接する2要素が1つの子試合を構成する。
- `loser_to_winner_permutation[i]`は、敗者側の`i`番目の試合IDが勝者側順序の何番目にあるかを1始まりで示す。
- 置換が`[1, 2, ...]`なら`mirrored`、それ以外は`permuted`とする。`permuted`の場合だけ診断コード`OUTCOME_BRANCH_ORDER_DIFFERS`を設定する。
- すべての分岐が`mirrored`の場合だけ、全体の`symmetry`を`mirrored`とする。

## 表示側の扱い

表示処理は`logical_layout`があればその順序を正本として使う。不在または`null`なら旧形式として扱う。メタデータが存在するのに参照、順位帯、置換、対称性が矛盾する場合は、推測で補わず検証エラーとする。
