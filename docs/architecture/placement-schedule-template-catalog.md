# 順位決定トーナメント日程テンプレートcatalog

## 1. 目的

順位決定トーナメントの日程配置は、対応する大会構成が有限であることを利用し、開発時に
CP-SATで事前計算する。本番Lambdaはpackageに同梱したJSONから配置を取得し、実際の試合ID、
コートID、時刻、順位枠、チーム注記へ復元する。通常の収録キーでは本番リクエスト中に
CP-SATを実行しない。同順位リーグと1日目リーグはこのcatalogの対象外である。

公開API、保存JSON、schema `0.2.0`、`SolverMetrics`の形は変更しない。catalogのversion、生成環境、
最適性証明、digestは内部resourceにだけ保存する。

## 2. キーと収録範囲

キーはruleset、トーナメント数、1トーナメントの人数、コート数、正規化済み主催者審判数、
`day2_fallback`から成る。主催者審判数はコート数を上限として正規化する。

```text
5トポロジー
× court_count 1..16
× organizer_capacity 1..court_count
× fallback 2種類
= 1,360キー
```

5トポロジーは`2x4`、`2x8`、`3x8`、`2x16`、`4x8`である。各shardは272キーを持ち、
各キーを`available`または`proven_infeasible`として記録する。timeoutや`UNKNOWN`はcatalogへ
保存しない。主催者審判数0はcatalogを参照せず、入力エラーとして扱う。

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
resourceを同梱し、起動後の最初の参照時に全1,360キーを検証してcacheする。

catalogの欠落、version不一致、digest不一致、canonical位置不整合では、安定化済みCP-SATへ
フォールバックする。成功時は`PLACEMENT_TEMPLATE_FALLBACK_USED`警告を応答へ残す。
`proven_infeasible`は正常なcatalog結果なのでフォールバックしない。

## 4. 生成と更新

各CP-SATは`num_search_workers=1`で実行する。通常は1トポロジーを1プロセスが担当し、独立した
トポロジーを2〜3プロセスまで並列化する。中断後は`--resume`でdigest検証済みcheckpointを
再利用する。同一コート数で理論下限が同じ場合は、より厳しい主催者能力・strict設定で下限を
達成した配置を、hydrateと独立検証に合格したキーへ再利用する。追加コートが未使用でも同じ
下限を達成する場合は、コート使用差を再集計したうえでコート数が多いキーにも再利用できる。
またstrictでは、新しいコートの最初の実試合を主催者が担当できるのは第1セクションまたは決勝だけ
なので、実効コート数は最大`organizer_capacity + pool_count`となる。この数以上のコートで証明した
最小配置は、同じ主催者能力でコート数だけが多いstrictキーにも再利用する。

```console
uv run python scripts/generate_placement_templates.py --topology 2x4 --workers 1 --resume
uv run python scripts/generate_placement_templates.py --topology 2x8 --workers 1 --resume
uv run python scripts/generate_placement_templates.py --topology 3x8 --workers 1 --resume
uv run python scripts/generate_placement_templates.py --topology 2x16 --workers 1 --resume
uv run python scripts/generate_placement_templates.py --topology 4x8 --workers 1 --resume
uv run python scripts/generate_placement_templates.py --merge
uv run python scripts/generate_placement_templates.py --check
```

generatorは理論下限から固定horizonを増やし、審判条件を満たさない配置を決定的なno-goodで
除外する。より短いhorizonの全候補を尽くした証明後、最初の実行可能配置を採用するため、使用
セクション数の最小性は必ず証明される。下位目的は非負下限0へ到達した辞書順の段階までを証明済み
とし、最初の未証明段階以降は未証明として保存する。候補はcanonical位置から再度hydrateし、
独立validatorに合格した場合だけcheckpointへatomicに保存する。

コートごとの直前実試合をsection間の状態としてCPモデル内で追跡する。入力コート順に、直前試合の
勝者が当該sectionの試合・先に選ばれた審判候補と衝突しない場合はチーム審判、それ以外は主催者
フォールバックとして数える。strictでは全非決勝戦にチーム審判を必須とし、organizerでは決勝を
含む主催者数を能力以下にする。このため、全候補を事後列挙しなくても固定horizonの実行不能を
CP-SATの`INFEASIBLE`として証明できる。

モデル規模を抑えるため、strictは全コートの審判候補を対称に扱うモデル、organizerは入力コート順の
フォールバック選択まで表現するモデルを使い分ける。いずれも同じ審判規則を強化も緩和もしない。
strictのhorizon下限では、決勝の最速sectionまでは第1sectionで開いたコートだけを使用でき、その後も
1sectionに主催者能力数までの決勝でしか新しいコートを開けない、という楽観的な最大配置数も使う。
これは実行可能配置を除外せず、明らかに容量不足の短いhorizonだけを探索前に証明する。

日程規則、canonical位置、template format、固定するOR-Tools条件を変えた場合は、rulesetまたは
format versionを更新し、全shardを新規生成する。旧checkpointや一部shardを新rulesetへ混在させない。
通常CIではCP-SATによる再生成を行わず、コミット済みresourceの完全性と全hydrate結果だけを検証する。
