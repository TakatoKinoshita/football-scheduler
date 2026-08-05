# 地域サッカー大会スケジューラー

地域サッカー大会の対戦、コート、セクション、審判を、大会規則に沿って生成・検証するWebアプリの開発プロジェクトです。エンドユーザーが開発環境をインストールする必要のない提供形態を目指しています。

現在のリポジトリでは、通常のWeb画面から大会名、2〜32チーム、ブロック数、分け方、
1〜16コート、開催時刻を段階的に入力し、1日目のリーグ日程を生成できる。Pythonのdomain層で
ブロックと総当たり対戦を生成し、OR-Tools CP-SATでコート、セクション、審判を配置した後、
独立した検証器で結果を確認する。

TypeScript／ViteのPWA、ブラウザ内自動保存、JSON入出力、オフラインでの保存済み結果閲覧、
本番API adapter、濫用対策のIaC、手動承認付きrelease経路も用意している。画面で現在利用できる
範囲は1日目リーグ日程までであり、リーグ結果入力、順位計算、2日目の完全順位決定トーナメント、
2日間の統合配置は後続issueで実装する。

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

画面では4手順のウィザード、入力項目別の日本語エラー、ブロック分け、日程表、チーム別予定を
確認できる。ローカル開発で日程生成を試す場合も、Turnstileのsite keyと同一originのAPIが
必要である。secret keyを`VITE_`環境変数へ設定してはならない。

生成APIは通常画面から`request_kind: "day1_league"`を付けた大会設定を受け付ける。
`random`と`seeded_snake`のブロック分けを利用でき、完成済み試合を含む従来の
`ScheduleRequest` JSONも互換経路として受け付ける。サーバー側へ大会データは永続保存しない。

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
