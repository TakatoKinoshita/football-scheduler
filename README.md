# 地域サッカー大会スケジューラー

地域サッカー大会の対戦、コート、セクション、審判を、大会規則に沿って生成・検証するWebアプリの開発プロジェクトです。エンドユーザーが開発環境をインストールする必要のない提供形態を目指しています。

現在のリポジトリには、Issue #1「FaaS上でOR-Toolsの技術検証」で作成した最小実装と実測結果が含まれます。PythonとOR-Tools CP-SATで代表規模の日程を生成し、独立した検証器で結果を確認できます。大会規則の全機能やWeb画面はまだ実装していません。

AWS LambdaとSAMは技術検証の対象として実測した後、複数候補を同じ基準で比較しました。
MVPの本番構成は、S3とCloudFrontを公開入口とし、API GatewayからLambdaコンテナを
同期呼出しする構成を第一候補とします。CloudFront無料定額プランを利用できない場合の
代替構成や再評価条件を含む決定理由は、
[MVP本番インフラADR](docs/architecture/adr-0001-mvp-production-infrastructure.md)に記録しています。
本番環境はまだ構築・公開していません。

初期リリースで想定する利用規模、保存・共有、オフライン動作、費用、性能は
[MVP運用要件](docs/product/mvp-operational-requirements.md)にまとめています。本番インフラは
この要件と実測値を基に複数候補を比較し、上記ADRで決定しています。

## 開発環境の準備

通常のローカル開発には、次のものが必要です。

- [uv](https://docs.astral.sh/uv/)
- Git

Python 3.14とプロジェクトの依存関係はuvで管理します。リポジトリのルートで次を実行してください。

```console
uv sync --locked --all-groups
```

依存関係を意図的に変更した場合だけ`uv lock`でlockfileを更新し、変更内容を確認してください。
Lambdaコンテナ用の依存一覧も、同じ変更時にlockfileから再生成します。

```console
uv export --locked --no-dev --no-emit-project --no-header --output-file requirements-lambda.txt
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
```

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

## ディレクトリ構成

```text
.
├── .github/workflows/       # CI
├── docs/architecture/       # インフラ等の設計判断（ADR）
├── docs/product/            # MVPの利用・運用要件
├── docs/technical-spikes/   # 技術検証の条件と結果
├── events/                  # Lambda／SAMの固定入力
├── scripts/                 # fixtureの反復実行と測定
├── src/football_scheduler/
│   ├── application.py       # FaaS非依存のアプリケーション境界
│   ├── fixtures.py          # 固定入力
│   ├── lambda_handler.py    # Lambda用の薄いアダプター
│   ├── models.py            # JSON互換の入力・出力モデル
│   ├── solver.py            # CP-SATによる日程生成
│   └── validator.py         # ソルバーから独立した制約検証
├── tests/                   # 単体・結合テスト
├── Dockerfile               # Lambdaコンテナ
├── pyproject.toml           # Pythonプロジェクト設定
├── requirements-lambda.txt # lockfileから生成したコンテナ用依存一覧
├── template.yaml            # 公開入口を持たないSAMテンプレート
└── uv.lock                  # 固定した依存関係
```

大会規則と実装上の正本は`AGENTS.md`です。技術検証のために制約を黙って緩和せず、未実装の規則と未測定の値を明示します。
