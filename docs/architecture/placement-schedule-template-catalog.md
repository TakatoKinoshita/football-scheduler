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

8・16チームの下位目的を再最適化する場合は、証明済みの最小horizonを変更せず、対象shardを
個別に処理する。24・32チームの3shardはraw file SHA-256と内部canonical digestの両方を
処理前後に検査し、1 byteでも変更されていれば停止する。

```console
uv run python scripts/generate_placement_templates.py --optimize-lower-objectives --topology 2x4 --workers 2 --resume
uv run python scripts/generate_placement_templates.py --optimize-lower-objectives --topology 2x8 --workers 2 --resume
uv run python scripts/generate_placement_templates.py --merge
uv run python scripts/generate_placement_templates.py --check
```

optimizerは基礎generator `placement-template-generator-v8`を維持し、対象entryのprovenanceにだけ
`placement-lower-objective-optimizer-v1`を記録する。未処理entryではfield自体をJSONへ出力しないため、
既存entryと対象外shardのdigestは変化しない。各key・各目的段階はversion付きcheckpointへatomicに
保存し、入力entry digestが一致する完全な6段階だけを`--resume`で再利用する。証明フラグは常に
`true...true,false...false`の連続prefixとし、gap 0、最大待ち1、コート移動0、コート利用偏りの
算術下限へ到達した実配置は、hydrateと独立validatorに合格した後だけ安全に証明済みへ昇格する。

generatorは理論下限から固定horizonを増やし、目的変数を持たない実行可能性モデルで探索する。
より短いhorizonの実行不能証明後、最初の実行可能配置を採用するため、使用
セクション数の最小性は必ず証明される。下位目的は非負下限0へ到達した辞書順の段階までを証明済み
とし、最初の未証明段階以降は未証明として保存する。候補はcanonical位置から再度hydrateし、
通常の全目的モデルへ配置を固定して監査値を再構築する。その後、独立validatorに合格した場合だけ
checkpointへatomicに保存する。

コートごとの直前実試合をsection間の状態としてCPモデル内で追跡する。入力コート順に、直前試合の
勝者が当該sectionの試合・先に選ばれた審判候補と衝突しない場合はチーム審判、それ以外は主催者
フォールバックとして数える。strictでは全非決勝戦にチーム審判を必須とし、organizerでは決勝を
含む主催者数を能力以下にする。このため、全候補を事後列挙しなくても固定horizonの実行不能を
CP-SATの`INFEASIBLE`として証明できる。

モデル規模を抑えるため、strictは全コートの審判候補を対称に扱うモデル、organizerは入力コート順の
フォールバック選択まで表現するモデルを使い分ける。依存関係の推移律ですでに2section以上離れる
conflict pairは重複制約を作らず、strictのコートは最初に使用される順へcanonical化する。
解析下限で全使用枠が飽和する構成は、試合と有効slotの順列、依存関係、全conflict pairだけからなる
小型モデルを先に使う。連続して使用するコートでは直前sectionの勝者が審判候補になるため、全
conflict pairのsection差と決勝・コート開設時の主催者能力を満たした候補は既存審判処理でも検証する。
専用モデルが候補を得られない場合は通常の固定horizonモデルへ戻り、専用モデルの失敗を実行不能証明
として扱わない。いずれも同じ審判規則を強化も緩和もしない。

organizerでは、全conflict pairのsection差を2以上にしたsection-firstモデルも先に使う。この条件下では
直前sectionの任意の試合勝者が次sectionの全試合に対して安全で、同時に使う審判供給元同士も衝突
しない。section `s`の試合数を`n_s`、決勝数を`f_s`、主催者能力を`O`とすると、第1sectionは
`n_1 <= O`、以降は`f_s <= O`かつ`n_s - n_(s-1) <= O`を満たすように解く。非決勝戦を直前sectionで
使用したコートへ安定順で割り当て、決勝と増加分を残りのコートへ置くと、必要な主催者審判数は
`max(f_s, n_s - n_(s-1))`以下になる。復元後は通常の審判処理と固定監査で再検証する。この十分条件で
候補がない場合も実行不能とはみなさず、過去sectionの勝者を使える通常の完全モデルへ戻る。

strictのhorizon下限では、決勝の最速sectionまでは第1sectionで開いたコートだけを使用でき、その後も
1sectionに主催者能力数までの決勝でしか新しいコートを開けない、という楽観的な最大配置数も使う。
最初の決勝時刻には通常の依存深さだけでなく、同じプールの決勝前に必要な`pool_size - 2`試合を
主催者能力数のコートで処理し、決勝直前に完全休憩1sectionを空ける容量下限も含める。
複数の決勝で新しいコートを開く場合は、各決勝から逆算したラウンド別deadlineまでに必要な祖先
試合数を数え、その時点までの楽観的なコート容量を超える開設時刻を除外する。全プールの決勝を
コート開設に使う場合は、最高順位帯の決勝による最後の開設を最終sectionに固定する。organizerでも、
未使用コートの最初の試合は主催者審判になるため、第s sectionまでに開けるコート数を高々
`s * organizer_capacity`として容量下限へ含める。
これは実行可能配置を除外せず、明らかに容量不足の短いhorizonだけを探索前に証明する。

さらにstrictでは、sectionごとの試合数を「第1sectionで開けるコート数と、そのsectionまでに行われた
決勝数の和」以下とする必要条件を、完全モデルの冗長cutとsection-only緩和問題の双方へ入れる。
organizerの緩和問題では、第`s` sectionまでに主催者能力`O`ずつしか新規コートを開けないことから、
sectionごとの試合数を`min(court_count, s * O)`以下にする。
依存関係、完全休憩、決勝順、累積コート開設数だけの緩和問題でも実行不能なら、そのhorizonは安全に
下限から除外できる。3プール各8チーム・9コート以上・主催者7の6section境界は、この緩和を通過するが、
終端sectionで必要になる相互両立可能な審判供給元をcanonical経路上で全列挙すると不足するため、
検証済みの追加下限7を使う。主催者8以上には6sectionの独立検証済み配置があり、この追加下限を
適用しない。

3プール各8チーム・主催者2のorganizerでは、コートラベルを除いた直前実試合chainを完全列挙し、
7sectionが実行不能であることを確認した。7sectionで開ける理論上限14コートでも実行不能なので、
8コート以上のキーには検証済みの追加下限8を使う。8sectionの配置は独立validatorまで通過している。
2プール各16チームの8sectionでは、連続active制約により第7sectionにも第4ラウンドを置く必要が
あり、その8つの第1ラウンド祖先はすべて第1sectionに必要となる。organizer主催者7以下では
第1sectionの能力を超えるため、検証済みの追加下限9を使う。
4プール各8チームのorganizer 6section境界は、強制されるラウンド帯と終端sectionで同時に必要な
審判供給元frontierを全列挙している。主催者5以下ではコート数によらず7section以上、主催者6では
14コート、主催者7では12コートが最初の6section実行可能構成となる。境界の2構成はcanonical
witnessを通常の固定監査と独立validatorへ通し、より多いコート・主催者能力へ再利用する。

2プール各16チーム・8コート・主催者1・organizerの12section境界では、空き枠を最終sectionへ
偏らせた順列モデルが実行不能になる。このキーにはcanonical位置で保持した検証済みwitnessを
初期候補として使い、通常と同じ審判再構築、全目的モデルへの固定監査、独立validatorを通過した場合
だけ採用する。witness自体を検証の代替にはしない。

日程規則、canonical位置、template format、固定するOR-Tools条件を変えた場合は、rulesetまたは
format versionを更新し、全shardを新規生成する。旧checkpointや一部shardを新rulesetへ混在させない。
通常CIではCP-SATによる再生成を行わず、コミット済みresourceの完全性と全hydrate結果だけを検証する。
