# 地域サッカー大会スケジューラー

地域サッカー大会の対戦、コート、セクション、審判を、大会規則に沿って生成・検証するWebアプリの開発プロジェクトです。エンドユーザーが開発環境をインストールする必要のない提供形態を目指しています。

現在のリポジトリでは、通常のWeb画面から大会名、2〜32チーム、ブロック数、分け方、
1〜16コート、開催時刻を段階的に入力し、1日目のリーグ日程を生成できる。Pythonのdomain層で
ブロックと総当たり対戦を生成し、OR-Tools CP-SATでコート、セクション、審判を配置した後、
独立した検証器で結果を確認する。配置では使用セクション数を最優先で最小化し、その解集合で
リーグ戦のチーム審判回数の最大差を最小化する。チーム別の審判回数と最大差はJSON結果と
独立検証の集計へ保存する。1日目は、同じチームが連続するセクションで試合またはチーム審判を
担当する場合、役割の組合せにかかわらず同じコートへ配置する。この条件はハード制約であり、
設定上限内で日程を延ばしても満たせなければ生成を失敗させる。空きセクションを挟む移動だけは
許可し、総コート移動回数のソフト制約で抑える。2日目専用モデルのコート移動は従来どおり
ソフト制約として扱う。

TypeScript／ViteのPWA、ブラウザ内自動保存、JSON入出力、オフラインでの保存済み結果閲覧、
本番API adapter、濫用対策のIaC、手動承認付きrelease経路も用意している。画面では1日目リーグ
日程の生成、試合結果の入力、ブロック順位の確定、順位未確定時の仮トーナメントと
上位・下位の完全順位決定トーナメント作成、順位未確定時を含む2日目の時刻・コート・審判配置まで利用できる。
2日目は開催時刻を先に入力し、1つの作成操作でトーナメントと日程を続けて生成する。
仮トーナメントはブロック順位枠を正本とし、順位確定後も組合せを変えずにチーム名を反映する。任意参加数の予備戦・
不戦通過・全順位決定と、再現可能なシード抽選・同一ブロック初戦回避をJSONへ保存する。
2日目日程も順位枠を正本とし、順位確定後は配置を変えずにチーム名だけを反映する。未確定の全勝敗経路を考慮して休憩と役割衝突を検証し、直前試合の勝者を審判へ
割り当てる。上位トーナメント決勝は最後の実試合セクションへ必ず配置し、日程の最短化を
保った範囲で下位決勝も同じ最終セクションへ寄せる。両決勝を同時開催できない場合は、下位
決勝配置の監査情報はJSONへ保存し、利用者が対応すべき例外だけを画面と印刷へ表示する。確定済み日程では2日目の結果を依存順に入力でき、同点時のPK戦を含む全結果を
サーバー側で再検証して、上位・下位を通した総合1位から最下位までを確定・保存・印刷できる。
トーナメント表は、各プールが8・16チームの対称な正規ブラケットなら、水平版と垂直版を
画面上で切り替えられる。既定はチーム枠を縦に並べて勝者側を右、敗者側を左へ結ぶ水平版で、
選択は大会JSONへ含めず端末の表示設定として保持する。それ以外は理由を表示して、勝者側を上、
敗者側を下へ結ぶ標準版へフォールバックする。試合番号・開始時刻と決勝等を図へ表示し、得点・PK・勝者・最終順位を含む
完全な文字情報は図のアクセシブル説明で確認できる。17〜32チームの標準版は初戦概要と
最大16枠の順位帯ページへ分割し、同じ継続記号で進路を示す。画面では図だけを横スクロールでき、
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

画面では5手順のウィザード、入力項目別の日本語エラー、ブロック分け、1日目の日程・結果入力・
順位確定、順位未確定でも作成できる2日目の仮トーナメントと仮日程、確定後のチーム名反映、
2日目の結果入力と総合最終順位を日別タブで確認できる。ローカル開発で日程生成を試す
場合も、Turnstileのsite keyと同一originのAPIが必要である。secret keyを`VITE_`環境変数へ
設定してはならない。

生成APIは通常画面から`request_kind: "day1_league"`を付けた大会設定を受け付ける。
`random`、`seeded_snake`、`manual`のブロック分けを利用でき、完成済み試合を含む従来の
`ScheduleRequest` JSONも互換経路として受け付ける。順位確定は`league_standings`、2日目の
一括作成は任意の`league_standings`を持つ`day2_creation`として同じ保護されたAPIへ要求する。
`day2_creation`は1つのTurnstile tokenでトーナメント表と日程を順番に生成し、両方の独立検証が
成功した場合だけ返す。後方互換用の`tournament_plan`と`day2_schedule`も引き続き受け付ける。
2日目の全結果検証と総合順位確定は`tournament_results`で要求する。Turnstileのactionは
`day2_creation`の`create_day2`を含め、各`request_kind`と一致する場合だけ受理する。
サーバー側へ大会データは永続保存しない。

`manual`では手順2に全チームの割当て先を表示し、固定したいチームだけA、B…の各ブロックを
選択できる。未割当て数とブロック別人数をその場で確認でき、未割当てチームは日程生成時に
抽選番号で再現可能にシャッフルし、人数差1以内となるよう自動配置する。手動指定だけで
人数上限を超えた場合は、指定済み所属を動かさず修正箇所を表示する。利用者の指定は表示名ではなく
チームIDで`league.manual_blocks`へ保存し、補完後の完全な所属と自動配置監査は
`league_plan`へ分けて保存するため、再読込みとJSON入出力でも両者を区別できる。
チーム追加やブロック数変更では、有効な指定を残して影響分だけ未割当てへ戻す。

## トーナメント表レイアウトのローカル比較

本番画面、API、Turnstileを使わず、上位トーナメント表だけを固定fixtureから画像化できる。
Web依存関係を準備した後、`web`ディレクトリで次を実行する。

```console
cd web
npm run preview:brackets
```

画像化の対象は、8・16チームの完全順位決定表と、上位シードの予備戦免除を含む7・9チーム表である。
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
アルファベット9文字の境界名を含み、7・9チームfixtureはシードと予備戦を確認する。
16チームfixtureは勝者側と敗者側が対称な正規ブラケットであることを確認する。
各fixtureの下位トーナメント参加数は0である。本番の
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
