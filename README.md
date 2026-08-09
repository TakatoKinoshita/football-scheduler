# 地域サッカー大会スケジューラー

地域サッカー大会の対戦、コート、セクション、審判を、大会規則に沿って生成・検証するWebアプリの開発プロジェクトです。エンドユーザーが開発環境をインストールする必要のない提供形態を目指しています。

## 決勝方式（schema `0.2.0`）

決勝方式は「2・3・4個の順位決定トーナメント」または「同順位リーグ」から
1日目生成前に選ぶschema `0.2.0`の仕様を確定した。順位決定トーナメントは8、16、24、
32チームの対応構成だけを扱い、同順位リーグは4〜32チームで厳密な同順位方式と最下位統合方式を
選べる。入力契約、許可ブロック数、端数処理、審判、仮日程、旧JSONの扱いは
[決勝方式仕様](docs/product/final-stage-formats.md)を正本とする。

Web画面と生成APIはschema `0.2.0`で両形式を扱う。順位未確定時も`LeagueRank`参照による
仮計画・仮日程を保存・印刷でき、順位確定後は配置を変えずにチーム名を反映する。同順位リーグは
通常得点だけを入力し、引き分けを認める。グループ順位と1位から最下位までの総合順位は
サーバーで再検証して保存する。schema `0.1.0`の保存JSONは閲覧・印刷専用で読み込み、編集用コピーでは
生成結果を消去して決勝方式の再選択を求める。

## 現在の実装（schema `0.2.0`）

現在のリポジトリでは、通常のWeb画面を「大会・チーム」「日程設定・生成」「1日目」「2日目」の
4タブに整理している。「大会・チーム」で大会名、4〜32チーム、1〜16コートを入力し、
「日程設定・生成」で両日共通、1日目、2日目の順に設定を確認して、1つの操作で両日の日程を生成する。
Pythonのdomain層で
ブロックと総当たり対戦を生成し、OR-Tools CP-SATでコート、セクション、審判を配置した後、
独立した検証器で結果を確認する。配置では使用セクション数を最優先で最小化し、その解集合で
リーグ戦のチーム審判回数の最大差を最小化する。チーム別の審判回数と最大差はJSON結果と
独立検証の集計へ保存する。1日目は、同じチームが連続するセクションで試合またはチーム審判を
担当する場合、役割の組合せにかかわらず同じコートへ配置する。この条件はハード制約であり、
設定上限内で日程を延ばしても満たせなければ生成を失敗させる。空きセクションを挟む移動だけは
許可し、総コート移動回数のソフト制約で抑える。2日目同順位リーグでも、連続セクションの
試合・チーム審判は同一コートをハード制約とする。

TypeScript／ViteのPWA、ブラウザ内自動保存、JSON入出力、オフラインでの保存済み結果閲覧、
本番API adapter、濫用対策のIaC、手動承認付きrelease経路も用意している。日別の結果タブでは
生成した日程とブロック分けの閲覧、試合結果の入力、ブロック順位の確定、順位未確定時の仮決勝計画と
順位決定トーナメントまたは同順位リーグの作成、順位未確定時を含む2日目の時刻・コート・審判配置まで利用できる。
2日目の開催時刻と決勝方式は日程生成前に入力し、統合された生成操作で決勝計画と日程を続けて生成する。
仮計画はブロック順位枠を正本とし、順位確定後も組合せを変えずにチーム名を反映する。
順位決定トーナメントは対応表の4・8・16チーム順位帯を順序付きプールとして生成し、予備戦と不戦通過を使用しない。
同順位リーグは厳密方式または最下位統合方式で総当たりグループを生成し、端数構成と1チーム群の
警告をJSONへ保存する。
2日目日程も順位枠を正本とし、順位確定後は配置を変えずにチーム名だけを反映する。順位決定
トーナメントは未確定の全勝敗経路を考慮して休憩と役割衝突を検証し、決勝以外は直前の実試合の
勝者を審判へ割り当てる。全プールの決勝は主催者審判とし、最高順位帯の決勝を最後の実試合
セクションへ必ず配置する。他の決勝は使用セクション数を増やさない範囲で終了時刻へ寄せる。
同順位リーグは全参加チームを審判候補とし、最終セクションへ特別な試合を固定しない。確定済み
日程では2日目の結果を入力でき、形式に応じた結果検証を経て、順序付きプールまたはグループを
通した総合1位から最下位までを確定・保存・印刷できる。
トーナメント表は、各プールが8・16チームの対称な正規ブラケットなら、水平版と垂直版を
画面上で切り替えられる。既定はチーム枠を縦に並べて勝者側を右、敗者側を左へ結ぶ水平版で、
選択は大会JSONへ含めず端末の表示設定として保持する。それ以外は理由を表示して、勝者側を上、
敗者側を下へ結ぶ標準版へフォールバックする。試合番号・開始時刻と決勝等を図へ表示し、得点・PK・勝者・最終順位を含む
完全な文字情報は図のアクセシブル説明で確認できる。schema `0.1.0`の閲覧互換で扱う
17〜32チームの旧ブラケットは、標準版を初戦概要と最大16枠の順位帯ページへ分割し、同じ継続記号で
進路を示す。画面では図だけを横スクロールでき、
水平版はA4縦、垂直版と標準版はA4横の2日目印刷・ブラケット専用印刷を、保存済みデータから
オフラインでも利用できる。
新しい決勝配置監査情報を持たない保存済み日程は拒否せず、決勝より後に実試合がある場合は
「旧ルールの日程」と警告する。旧日程でも閲覧、結果入力、順位確認、印刷は継続できる。

AWS LambdaとSAMは技術検証の対象として実測した後、複数候補を同じ基準で比較しました。
対象AWS accountではCloudFront Free定額プランを利用できないため、MVPはCloudflare Pagesと
Pages Functionを公開入口とし、API GatewayからLambdaコンテナを同期呼出しします。変更理由は
[Cloudflare Pages代替ADR](docs/architecture/adr-0002-cloudflare-pages-fallback.md)、元の比較は
[MVP本番インフラADR](docs/architecture/adr-0001-mvp-production-infrastructure.md)に記録しています。
本番環境はCloudflare PagesとAWSの初期構成を公開済みである。公開環境の変更は、production
workflowのplanでchange setを確認し、別の手動承認を経たapplyで行う。

初期リリースで想定する利用規模、保存・共有、オフライン動作、費用、性能は
[MVP運用要件](docs/product/mvp-operational-requirements.md)にまとめています。本番インフラは
この要件と実測値を基に複数候補を比較し、上記ADRで決定しています。

## 開発環境の準備

通常のローカル開発には、次のものが必要です。

- [uv](https://docs.astral.sh/uv/)
- Git
- Node.js 22

Python 3.14とプロジェクトの依存関係はuvで管理します。リポジトリのルートで次を実行してください。

```console
uv sync --locked --all-groups
```

依存関係を意図的に変更した場合だけ`uv lock`でlockfileを更新し、変更内容を確認してください。
Lambdaコンテナ用の依存一覧も、同じ変更時にlockfileから再生成します。

```console
uv export --locked --no-dev --no-emit-project --no-header --output-file requirements-lambda.txt
```

Web画面の依存関係は`web/package-lock.json`で固定する。

```console
cd web
npm ci
npm run dev
```

画面は「大会・チーム」「日程設定・生成」「1日目」「2日目」の4タブで構成する。大会情報と
使用コートを最初のタブへまとめ、共通設定、1日目設定、2日目設定と生成操作を2番目のタブへ集約する。
日別タブではブロック分けと日程の閲覧、結果入力、順位確定、順位未確定時の仮決勝計画と仮日程、
確定後のチーム名反映、総合最終順位を確認できる。ローカル開発で日程生成を試す
場合も、Turnstileのsite keyと同一originのAPIが必要である。secret keyを`VITE_`環境変数へ
設定してはならない。

現行schema `0.2.0`の通常画面は、統合生成APIへ`request_kind: "schedule_creation"`と
`generation_scope: "all" | "day2_only"`を付けた大会設定を送る。Turnstile actionは
`create_schedule`とする。初回生成は`all`、2日目設定だけを変更した再生成は既存結果を添えた
`day2_only`を使用する。成功時は両日の正規結果をまとめて返し、途中で失敗した場合は段階を含む
診断だけを返すため、画面の保存状態を部分的な結果で置き換えない。
`random`、`seeded_snake`、`manual`のブロック分けを利用でき、完成済み試合を含む従来の
`ScheduleRequest` JSONも互換経路として受け付ける。順位確定は`league_standings`、2日目の
一括作成は任意の`league_standings`を持つ`day2_creation`として同じ保護されたAPIへ要求できる。
`day2_creation`は1つのTurnstile tokenで選択形式の計画と日程を順番に生成し、両方の独立検証が
成功した場合だけ返すが、`day1_league`とともに通常画面では使用しない互換経路である。
形式別の生成入口として`tournament_plan`、`day2_schedule`、
`same_rank_league_plan`、`same_rank_day2_schedule`も受け付ける。2日目の全結果検証と総合順位確定は
トーナメントでは`tournament_results`、同順位リーグでは`same_rank_league_results`で要求する。Turnstileのactionは
`day2_creation`の`create_day2`を含め、各`request_kind`と一致する場合だけ受理する。
サーバー側へ大会データは永続保存しない。

`manual`では「日程設定・生成」タブの1日目設定に全チームの割当て先を表示し、固定したいチームだけA、B…の各ブロックを
選択できる。未割当て数とブロック別人数をその場で確認でき、未割当てチームは日程生成時に
抽選番号で再現可能にシャッフルし、人数差1以内となるよう自動配置する。手動指定だけで
人数上限を超えた場合は、指定済み所属を動かさず修正箇所を表示する。利用者の指定は表示名ではなく
チームIDで`league.manual_blocks`へ保存し、補完後の完全な所属と自動配置監査は
`league_plan`へ分けて保存するため、再読込みとJSON入出力でも両者を区別できる。
チーム追加やブロック数変更では、有効な指定を残して影響分だけ未割当てへ戻す。

## トーナメント表レイアウトのローカル比較

本番画面、API、Turnstileを使わず、トーナメント表を固定fixtureから画像化できる。
Web依存関係を準備した後、`web`ディレクトリで次を実行する。

```console
cd web
npm run preview:brackets
```

現行schema `0.2.0`相当の8・16チーム完全順位決定表に加え、schema `0.1.0`の閲覧互換を
確認するため、旧仕様の予備戦免除を含む7・9チーム表も画像化できる。7・9チーム表は新規生成の
対応構成ではない。
表示処理が利用する順序情報は[トーナメント論理配置契約](docs/tournament-logical-layout.md)、
探索で採用した表示規則は[トーナメント表レイアウト規則](docs/tournament-bracket-layout.md)を参照する。
出力先は実行ごとに作られる`/tmp/football-scheduler-bracket-previews-*`で、生成したPNGの
絶対パスを標準出力へ表示する。生成物はリポジトリへ保存しない。対象を限定する場合や
出力先を明示する場合は次のように指定する。

```console
npm run preview:brackets -- --fixture upper-7-seeded --layout standard
npm run preview:brackets -- --fixture upper-8 --layout horizontal
npm run preview:brackets -- --output-dir /tmp/football-scheduler-bracket-review
```

ブラウザで比較する場合は`npm run dev`を起動し、表示されたoriginの
`/bracket-preview.html`を開く。画面の選択欄または`fixture`と`layout`のquery parameterで
切り替えられる。このページはViteの本番build entryではない。本番アプリは共通presentation
registryから、参加数と論理配置に応じた既定レイアウトを選ぶ。

レイアウト候補は`TournamentBracketLayoutStrategy`を実装し、
レイアウトとrendererの組を`web/src/tournament-bracket-presentations.ts`へ登録する。
本番画面と比較ページは同じ登録を参照し、比較用の選択肢だけを
`web/src/tournament-bracket-preview-layouts.ts`で公開する。

固定データは`web/src/fixtures/tournament-bracket-preview/`に置く。8チームfixtureは日本語6文字と
アルファベット9文字の境界名を含み、旧schema互換用の7・9チームfixtureはシードと予備戦を確認する。
16チームfixtureは勝者側と敗者側が対称な正規ブラケットであることを確認する。本番の
トーナメント生成器から再生成または差分確認するコマンドは次のとおり。

```console
uv run python scripts/write_tournament_bracket_preview_fixtures.py
uv run python scripts/write_tournament_bracket_preview_fixtures.py --check
```

## 固定fixtureの実行

小さい疎通確認用fixtureは、次のように実行します。

```console
uv run python scripts/run_benchmark.py --fixture smoke
```

16チーム、4ブロック、3コート、リーグ24試合の代表fixtureを10回実行し、生の測定値を保存する例です。

```console
uv run python scripts/run_benchmark.py --fixture representative --repeat 10 --timeout 30 --json-output benchmark-results/representative-local.json
```

出力には各試行の結果、全体時間、取得可能な場合のプロセスメモリ、出力バイト数、再現性比較用ハッシュが含まれます。ローカルの値を実FaaSのコールドスタートや課金時間として扱わないでください。

## 品質チェック

CIと同じ検査は、次のコマンドで個別に実行できます。

```console
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest
uv run python scripts/write_tournament_bracket_preview_fixtures.py --check
uv run python scripts/verify_production_path.py --repeat 2 --maximum-seconds 30
cd web
npm run lint
npm test
npm run build
npm run build:functions
npm run test:e2e
```

32チームの本番経路検証は2回の実行に時間がかかる。API adapter、独立制約検証、30秒上限、
1 MB応答上限、同じseedでの再現性をまとめて確認する。

## Lambdaコンテナのローカル検証

[Docker](https://docs.docker.com/get-docker/)が必要です。Lambda Runtime Interfaceを含むコンテナをビルドして起動します。

```console
docker build --tag football-scheduler-faas-probe .
docker run --rm --publish 9000:8080 football-scheduler-faas-probe
```

コンテナを起動したまま、別のPowerShellからsmoke fixtureを直接invokeします。

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri 'http://localhost:9000/2015-03-31/functions/function/invocations' `
  -ContentType 'application/json' `
  -Body '{"fixture":"smoke"}'
```

これはローカルコンテナの疎通確認であり、実際のLambda環境の性能測定ではありません。

## SAMによるローカル検証

[Docker](https://docs.docker.com/get-docker/)と[AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)が必要です。`template.yaml`は関数を直接invokeする構成で、公開Function URLやAPI Gatewayを作成しません。

```powershell
sam build
sam local invoke SolverProbeFunction --event 'events\smoke.json'
```

実AWS環境へのデプロイは、アカウント、リージョン、費用監視、作成資源、削除手順を確認し、課金が発生し得る操作への承認を得てから行います。検証のためにHTTP公開が必要になった場合も、CORSだけに依存せず、認証、レート制限、濫用対策を先に設計してください。

デプロイ済みの非公開LambdaをAWS CLI経由で測定する場合は、物理関数名を確認して
次のように実行します。出力にはLambdaの処理時間、課金時間、最大使用メモリ、
初期化時間、正規化結果hashが含まれます。

```console
uv run python scripts/run_lambda_benchmark.py \
  --function-name FUNCTION_NAME \
  --event events/representative.json \
  --repeat 10 \
  --region us-east-1 \
  --json-output benchmark-results/representative-lambda.json
```

restrictiveなumaskでcheckoutしたソースも実Lambdaユーザーが読めるよう、Docker build
では成果物へ読み取り・directory traversal権限を明示しています。ローカル検証でも
可能なら非rootユーザーによるimportを確認してください。

測定条件、記録項目、成功基準は[技術検証レポート](docs/technical-spikes/faas-ortools.md)にまとめています。

## 本番リリース

本番構成、GitHub OIDC、Cloudflare Pages、手動承認、監視、費用停止、rollbackは
[本番runbook](docs/operations/production-runbook.md)にまとめています。大会データの自動保存、
JSON共有、復元範囲は[保存・共有・復元仕様](docs/product/data-save-and-recovery.md)を参照してください。
本番リソースの作成・変更・削除はrunbookだけを根拠に自動実行せず、対象と費用を確認して
ユーザーの明示承認を得てから行います。

## ディレクトリ構成

```text
.
├── .github/workflows/       # CI
├── docs/architecture/       # インフラ等の設計判断（ADR）
├── docs/product/            # MVPの利用・運用要件
├── docs/operations/         # 本番リリース、監視、復旧手順
├── docs/technical-spikes/   # 技術検証の条件と結果
├── events/                  # Lambda／SAMの固定入力
├── scripts/                 # fixtureの反復実行と測定
├── src/football_scheduler/
│   ├── api_handler.py       # API Gateway REST API adapter
│   ├── authorizer.py        # Pages proxy確認・Turnstile authorizer
│   ├── application.py       # FaaS非依存のアプリケーション境界
│   ├── day1_league.py       # 1日目リーグ入力と既存ソルバーの接続
│   ├── fixtures.py          # 固定入力
│   ├── lambda_handler.py    # Lambda用の薄いアダプター
│   ├── league.py            # ブロック分けと総当たり対戦生成
│   ├── models.py            # JSON互換の入力・出力モデル
│   ├── solver.py            # CP-SATによる日程生成
│   └── validator.py         # ソルバーから独立した制約検証
├── tests/                   # 単体・結合テスト
├── web/                     # TypeScript／Vite PWA、Pages Function、ブラウザ内保存
├── infra/production/        # 本番bootstrapとSAM template
├── Dockerfile               # Lambdaコンテナ
├── pyproject.toml           # Pythonプロジェクト設定
├── requirements-lambda.txt # lockfileから生成したコンテナ用依存一覧
├── template.yaml            # 公開入口を持たないSAMテンプレート
└── uv.lock                  # 固定した依存関係
```

大会規則と実装上の正本は`AGENTS.md`です。技術検証のために制約を黙って緩和せず、未実装の規則と未測定の値を明示します。
