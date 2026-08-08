# トーナメント論理配置契約

## 目的

`TournamentPoolPlan.logical_layout`は、完全順位決定トーナメントを表示処理が安定した順序で配置するための契約である。座標、用紙寸法、垂直・水平などの見た目は含めない。

プール全体の参加数が2のべき乗の場合、新規生成する対戦グラフは参加数だけで決まる正規ブラケットとする。同一ブロック初戦の回避と再戦遅延は初戦位置の割当てで最適化し、それ以降は勝者側と敗者側へ同じ位置対応を適用する。

## 対象と互換性

- 2のべき乗かつ2チーム以上の新規生成結果には`logical_layout`を設定し、すべての分岐を`mirrored`とする。
- 0・1チームおよび2のべき乗でない参加数では`logical_layout`を`null`とする。
- `logical_layout`がない既存の`schema_version: "0.1.0"`も受理する。
- 旧生成結果の`permuted`な`logical_layout`も引き続き受理する。
- 本契約は後方互換な追加情報であるため、トーナメント全体のスキーマバージョンは変更しない。
- 試合IDの形式と参加数ごとのID集合は維持する。ただし新規生成結果では、旧生成結果と比べて初戦枠への参加者割当てや後続試合の勝敗参照が変わる場合がある。
- 旧トーナメント計画は自己完結した参照を持つため移行しない。再生成した計画へ旧試合結果を適用し、参加者が一致しない場合は既存の結果整合性検証で拒否する。

## JSON形式

```json
{
  "logical_layout": {
    "layout_version": "1",
    "symmetry": "mirrored",
    "opening_entry_order": [],
    "match_positions": [
      {
        "match_id": "UT-RANK-1-4-M1",
        "rank_range": [1, 4],
        "order": 1
      }
    ],
    "branch_alignments": [
      {
        "rank_range": [1, 4],
        "status": "mirrored",
        "winner_source_order": [
          "UT-RANK-1-4-M1",
          "UT-RANK-1-4-M2"
        ],
        "loser_source_order": [
          "UT-RANK-1-4-M1",
          "UT-RANK-1-4-M2"
        ],
        "loser_to_winner_permutation": [1, 2],
        "diagnostic_code": null
      }
    ]
  }
}
```

## 正規ブラケットの生成規則

プール全体の参加数が2のべき乗の場合だけ、次の順序で生成する。

1. 上位半分と下位半分を組み、初戦の同一ブロック対戦を最小化する。初戦の`home`は上位側、`away`は下位側とする。
2. 初戦ペアを配置木の葉とし、各深さで同一ブロック由来の再戦を遅らせる親子関係を一度だけ決める。親ノード順を再帰的に決めた後、子を全`left`、全`right`の順で展開して固定初戦位置へ割り当てる。
3. 各段階の入力数を`m`とし、試合`i`へ位置`i`と`i + m / 2`を割り当てる。この対応を勝者参照と敗者参照の両方で共有し、分岐ごとの再最適化は行わない。

乱数は同点の初戦割当てと配置木の選択だけに使用し、試合ID間の依存構造には影響させない。非2べき乗プール内で再帰的に生成される2のべき乗部分は、従来の生成経路を維持する。

## 順序の定義

- `opening_entry_order`は、全参加者を含む最初の順位帯の試合を`match_positions.order`順に並べ、各試合の`home`、`away`の順で展開する。
- `match_positions.order`は、同じ`rank_range`内で1から連続する。
- `winner_source_order`と`loser_source_order`は、子順位帯の試合を論理順に並べ、各試合の`home`、`away`が参照する親試合IDを展開する。隣接する2要素が1つの子試合を構成する。
- `loser_to_winner_permutation[i]`は、敗者側の`i`番目の試合IDが勝者側順序の何番目にあるかを1始まりで示す。
- 置換が`[1, 2, ...]`なら`mirrored`、それ以外は`permuted`とする。`permuted`の場合だけ診断コード`OUTCOME_BRANCH_ORDER_DIFFERS`を設定する。
- すべての分岐が`mirrored`の場合だけ、全体の`symmetry`を`mirrored`とする。

## 表示側の扱い

表示処理は`logical_layout`があればその順序を正本として使う。不在または`null`なら旧形式として扱う。メタデータが存在するのに参照、順位帯、置換、対称性が矛盾する場合は、推測で補わず検証エラーとする。
