# 順位決定トーナメント日程テンプレートcatalog

## 1. 目的

順位決定トーナメントの日程配置は、対応する大会構成が有限であることを利用し、開発時に
CP-SATで事前計算する。本番Lambdaはpackageに同梱したJSONから配置を取得し、実際の試合ID、
コートID、時刻、順位枠、チーム注記へ復元する。通常の収録キーでは本番リクエスト中に
CP-SATを実行しない。同順位リーグと1日目リーグはこのcatalogの対象外である。

公開API、保存JSON、schema `0.2.0`、`SolverMetrics`の形は変更しない。catalogのversion、生成環境、
最適性証明、digestは内部resourceにだけ保存する。

## 2. v2のキーと収録範囲

現行catalogはformat `2`、ruleset `placement-schedule-v2`を使用する。主催者審判能力は大会規則により
使用コート数以上であり、1セクションの実試合数はコート数を超えないため、実効値をコート数へ
固定する。schema互換用の`organizer_capacity` fieldはentry keyに残すが、独立したキー軸および
`catalog_id`の要素にはしない。

```text
5トポロジー
× court_count 1..16
× day2_fallback 2種類
= 160キー
```

5トポロジーは`2x4`、`2x8`、`3x8`、`2x16`、`4x8`である。各shardは32キーを持ち、
各キーを`available`または`proven_infeasible`として記録する。timeoutや`UNKNOWN`はcatalogへ保存しない。
現在の160キーはすべて`available`である。`day2_fallback`は、能力が十分でも`strict`が非決勝戦の
主催者フォールバックを許可しないため、引き続きキーに含める。

テンプレートは実試合IDを保存せず、プールindex、順位範囲、論理順からなるcanonical試合位置を
使用する。コートは入力配列に対する0始まりのindexで保存する。実行時はトーナメント計画の
`logical_layout`から試合IDを復元し、全セクション・全コートの空スロット、審判、チーム経路、
時刻、監査値を再構築する。

## 3. Resourceと整合性

resourceは`src/football_scheduler/placement_templates/`に置く。

```text
manifest.json
placement-p2-s4.json
placement-p2-s8.json
placement-p3-s8.json
placement-p2-s16.json
placement-p4-s8.json
```

entry、shard、manifestは、それぞれ自己digest fieldを除いたcanonical parsed JSONのSHA-256を持つ。
manifestは5shardの順序、件数、digest、catalog root digestを固定する。Lambda imageとwheelの双方へ
resourceを同梱し、起動後の最初の参照時に全160キーを検証してcacheする。

catalogの欠落、version不一致、digest不一致、coverage不一致、canonical位置不整合では、通常経路と
区別できる`PLACEMENT_TEMPLATE_FALLBACK_USED`警告を残して安定化済みCP-SATへ切り替える。
コミット済みresourceの全対応トポロジー・コート数・fallbackは必ずcatalogへ解決され、通常経路で
このfallbackを発生させない。`proven_infeasible`は正常なcatalog結果なのでfallbackしない。

## 4. v1からv2への移行

v1はformat `1`、ruleset `placement-schedule-v1`として、主催者能力1からコート数までを独立軸にした
1,360キー（各shard 272キー）を持っていた。v1の意味とdigestは過去releaseおよびIssue #71・#73の
品質fixture・レポートで維持し、v2として読み替えない。

v2初回構築では、v1の`organizer_capacity == court_count`である160 entryだけを抽出した。配置、
6目的値、最適性証明、審判署名を変えずにformatとrulesetを更新し、全entryをhydrate、固定配置監査、
目的値再計算、独立validatorへ通した後、entry・shard・manifestのdigestを再計算した。CP-SATによる
再全列挙は行っていない。

移行元と出力先を分けて再現する場合は次を実行する。

```console
uv run python scripts/generate_placement_templates.py \
  --migrate-v1 \
  --source artifacts/placement-catalog-v1 \
  --output artifacts/placement-catalog-v2
uv run python scripts/generate_placement_templates.py \
  --check \
  --output artifacts/placement-catalog-v2
```

移行処理は、移行元がv1であること、各shardの対象が32件あること、全対象が`available`であること、
配置・目的値・審判署名が変わらないこと、全160件のhydrateと独立検証が成功することを確認してから
出力する。

## 5. 新規生成・checkpoint・merge

将来、日程規則の変更により再計算が必要になった場合も、v2 generatorは160キーだけを列挙する。
各CP-SATは`num_search_workers=1`で実行し、独立したトポロジーまたはキーを外側で並列化する。
checkpointはrulesetごとのdirectoryに保存し、v2のファイル名には主催者能力軸を含めない。
`--resume`ではentry digestとrulesetを検査し、v1 checkpointを混在させない。

```console
uv run python scripts/generate_placement_templates.py --topology 2x4 --workers 1 --resume
uv run python scripts/generate_placement_templates.py --topology 2x8 --workers 1 --resume
uv run python scripts/generate_placement_templates.py --topology 3x8 --workers 1 --resume
uv run python scripts/generate_placement_templates.py --topology 2x16 --workers 1 --resume
uv run python scripts/generate_placement_templates.py --topology 4x8 --workers 1 --resume
uv run python scripts/generate_placement_templates.py --merge
uv run python scripts/generate_placement_templates.py --check
```

generatorは理論下限から固定horizonを増やし、より短いhorizonの実行不能を証明した後、最初の
実行可能配置を採用する。主催者能力がコート数未満であることだけに必要だった下限、コート開設cut、
特殊witness、能力別checkpoint軸はv2の通常探索に使用しない。候補はcanonical位置からhydrateし、
通常の全目的モデルへ配置を固定して監査値を再構築し、独立validatorに合格した場合だけ保存する。

日程規則、canonical位置、template format、固定するOR-Tools条件を変えた場合は、rulesetまたは
format versionを更新し、全shardを新規生成する。通常CIではCP-SATによる再生成を行わず、
コミット済みresourceのdigest、coverage、全hydrate結果を検証する。

## 6. v1品質履歴

v1の8・16チーム用下位目的再最適化は
[Issue #71品質レポート](issue-71-placement-quality-report.md)、24・32チーム用current／legacy比較は
[Issue #73品質レポート](issue-73-placement-quality-report.md)を正本とする。これらの文書にある
1,360キー、各shard 272キー、能力別下限、optimizer checkpoint、当時のdigestは履歴値であり、
v2のcoverageや現在のresource digestを表さない。

## 7. 検証

```console
uv run python scripts/generate_placement_templates.py --check
uv build
uv run python scripts/check_placement_template_wheel.py dist
```

`--check`はmanifest・全shard・全entryのdigestと160キーのcoverageを検査し、全entryについて
hydrate、審判再構築、固定配置監査、6目的値再計算、独立validatorを実行する。wheel検証は
インストール前のwheel resourceから同じ160件を読み込めることを確認する。Lambda imageはbuild時に
package resourceを読み込み、同じ件数とdigest検査が通らない場合にbuildを失敗させる。
