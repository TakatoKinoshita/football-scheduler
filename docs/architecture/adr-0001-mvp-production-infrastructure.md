# ADR-0001: MVP本番インフラ構成

- 状態: 採用
- 決定日: 2026-08-05
- 対象: 初期リリース（MVP）
- 関連: issue #1、issue #2

## 1. 決定

MVPは、次の構成を第一候補として実装する。

- Webアプリを非公開のAmazon S3バケットへ配置する。
- Amazon CloudFrontのFree定額プランを、静的画面と計算APIの単一入口にする。
- CloudFrontからS3へはOrigin Access Control（OAC）を使い、S3を直接公開しない。
- `POST /api/v1/schedules:generate`だけをAmazon API GatewayのRegional REST APIへ転送する。
- API Gatewayから、既存のPython／OR-Toolsコンテナを使うAWS Lambdaを同期呼出しする。
- 大会データはサーバー側へ永続保存せず、ブラウザのIndexedDBとJSONファイルを正本にする。
- 保存済み画面はPWAのアプリシェルとIndexedDBからオフライン表示する。オフライン生成は行わない。
- AWSリージョンは、実測済みで費用を優先できる`us-east-1`から開始する。

CloudFront Free定額プランを対象AWSアカウントで利用できない場合は、静的配信を
Cloudflare Pages Freeへ差し替える。計算基盤、JSON契約、ブラウザ保存、オフライン範囲は
変更しない。この代替構成ではCloudflare Turnstileを必須とし、API Gateway側の制限も
維持する。

このADRは構成の決定だけを行う。本番リソースの作成と公開は後続issueで行う。

## 2. 要件と判断基準

[MVP運用要件](../product/mvp-operational-requirements.md)から、次をハードゲートとする。

- 最大32チーム、16コート、512試合、1日128セクション、入力1 MBを扱える。
- 生成開始から結果表示まで30秒以内とする。
- 月100生成未満を通常利用、月1,000生成を繁忙利用として扱う。
- クラウド費用は無料枠がない場合も月500円程度を目標とする。
- 大会入力と生成結果をクラウドへ永続保存しない。
- 利用者アカウント、クラウドDB、共同編集、公開閲覧リンクを導入しない。
- 保存済みの日程、審判割当て、チーム別予定、印刷画面はオフライン閲覧できる。
- CORSだけで公開計算資源を保護せず、Bot、レート、同時実行、予算を制限する。

ハードゲートを満たす候補を、5点満点で次の重み付けにより評価した。

| 評価軸 | 重み |
| --- | ---: |
| 運用負担と復旧容易性 | 30% |
| 濫用・セキュリティ対策 | 25% |
| 費用と予算余力 | 20% |
| 性能と上限余力 | 15% |
| ベンダー依存と移行容易性 | 10% |

同点の場合は運用負担、固定費の順に小さい候補を優先する。

## 3. 候補比較

料金、無料枠、制限は2026年8月5日に各社の公式資料で確認した。無料枠は他用途との
共有や将来の変更があり得るため、採否を無料枠だけには依存させない。

### 3.1 静的配信

| 候補 | 費用・制限 | 利点 | 不利点 |
| --- | --- | --- | --- |
| GitHub Pages | 公開リポジトリでは無料。サイト1 GB、月100 GBのsoft bandwidth limit | 現在のGitHub運用だけで配信でき、移行も容易 | APIと配信入口が分かれ、濫用対策と監視を別途統合する必要がある |
| Cloudflare Pages Free | 静的リクエストと帯域は無料・無制限。月500 build、20,000 files、1 file 25 MiB | Git連携、preview、response header設定、Turnstileとの統合が容易 | Cloudflareのアカウントと運用が追加される |
| S3＋CloudFront Free定額プラン | 月0ドル、月100万request・100 GB、S3 5 GB credit。超過課金なし | WAF、DDoS対策、TLS、API経路、監視を単一入口へ統合できる | AWSリソース数が増え、アカウントによって定額プランを利用できない |

S3＋CloudFrontは静的配信だけを見ると最小構成ではないが、計算APIとWAFを同じ入口へ
統合したときに、費用リスクと障害調査の経路を最も減らせるため採用する。

### 3.2 計算基盤

| 候補 | 技術適合性 | 費用・性能 | 判断 |
| --- | --- | --- | --- |
| AWS Lambdaコンテナ | 現行イメージを実AWSで検証済み。同期payload 6 MB、container image 10 GB、実行上限は要件を満たす | 2 GBでwarm p95 1.975秒、通常cold 2.876秒、最大201 MB。初回image起動は17.027秒を観測 | 採用。初回起動のばらつきと最大32チームは公開前に再検証する |
| Google Cloud Run | OCI container、scale-to-zero、最大60分request、最大instance数を設定できる | request-based billingは2百万request等の無料枠がある。現行Lambda用imageにはHTTP adapterが必要で、性能は未測定 | 代替候補。現時点では新規検証と別クラウド運用が増える |
| ブラウザ／WebAssembly | サーバー費用と通信障害を避けられる | 現行`ortools`はCPython向けnative共有libraryを使用する。公式配布はLinux、macOS、Windows向けで、公式のbrowser buildはない | ハードゲート不合格。別solverまたは独自WASM buildの技術検証なしには採用しない |

Lambdaの追加メモリ比較は採否を変えない。最大32チームの本番相当fixtureで30秒要件を
満たせない場合にだけ、メモリ変更、`ap-northeast-1`、Cloud Runを同じ入力で再比較する。

### 3.3 構成全体の採点

| 構成 | 運用 | 安全性 | 費用 | 性能 | 移行 | 加重得点 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| S3＋CloudFront＋API Gateway＋Lambda | 3 | 5 | 5 | 4 | 4 | **4.15** |
| Cloudflare Pages＋API Gateway＋Lambda | 3 | 4 | 5 | 4 | 5 | 4.00 |
| GitHub Pages＋API Gateway＋Lambda | 4 | 3 | 5 | 4 | 5 | 4.05 |
| Cloudflare Pages＋Cloud Run | 3 | 3 | 5 | 3 | 5 | 3.60 |

GitHub Pages構成は簡潔だが、静的配信と公開APIの入口が分かれる。Cloudflare Pages構成は
移行性が高いが、AWSとCloudflare双方の障害・秘密情報・監視を扱う。推奨構成はIaCの量が
増える代わりに、公開入口、WAF、費用通知、ログをAWSへ集約できる。

## 4. 責務とデータフロー

```text
利用者のブラウザ
  ├─ Service Worker: アプリシェルをcache
  ├─ IndexedDB: 大会入力、生成結果、直前の確定状態を保存
  ├─ JSON入出力: 端末間共有と利用者管理のbackup
  └─ HTTPS
       ↓
CloudFront + WAF
  ├─ /*       → 非公開S3 bucket（静的asset）
  └─ /api/*   → API Gateway Regional REST API
                    ├─ 使用量枠、route throttle、origin確認
                    ├─ Lambda authorizer: Turnstile tokenを検証
                    └─ solver Lambda container
                         ├─ 入力検証
                         ├─ OR-Tools求解
                         ├─ 独立制約検証
                         └─ JSON応答後に入力・結果を保持しない
```

CloudFrontからS3へのアクセスはOACで限定する。API GatewayにはCloudFrontだけが付与する
origin確認headerを必須identity sourceとして設定し、headerがない要求はauthorizerや
solverを呼ばず拒否する。このheaderは利用者認証ではなく、origin間の防御である。

利用者アカウントは作らない。Cloudflare Turnstileのmanaged widgetをBot対策として使い、
tokenはserver-sideでSiteverifyへ送り、hostname、action、単回利用を検証する。Turnstileの
secretはリポジトリやブラウザへ置かない。単回利用tokenの再利用を許さないよう、authorizer
cacheは無効にする。API keyを使用量計測に使う場合も、公開clientに含まれる値を認証情報と
して扱わない。

## 5. API、時間、使用量の上限

| 項目 | 決定値 |
| --- | --- |
| endpoint | `POST /api/v1/schedules:generate` |
| request／response | version付きJSON。入力最大1 MB、応答最大1 MB |
| cache | API応答はCloudFront、Service Workerとも保存しない |
| solver時間 | 最大20秒。実行不能とtimeoutを区別する |
| Lambda timeout | 28秒 |
| API Gateway integration timeout | 29秒 |
| browser待機 | 30秒で終了し、入力を保持して再試行を案内する |
| 同時実行 | solver Lambdaのreserved concurrencyを3とする |
| route throttle | 0.2 request/秒、burst 3 |
| 使用量枠 | 全利用者合計で月3,000 accepted generationを目標上限とする |
| WAF | API pathへIP単位rate limit、既知の不正request遮断、1 MB超過の早期拒否を設定する |

API Gatewayのthrottleとusage plan quotaはbest-effortであり、厳密な課金停止装置ではない。
reserved concurrencyを3にできない小さいAWSアカウントでは、Service Quotasを調整するまで
公開しない。AWS Budgetsを50%、80%、100%で通知し、100%到達時はAPI stageを停止する
runbookを用意する。大会データ用DBを増やして厳密なquotaを実装することはMVPでは行わない。

## 6. 費用試算

無料枠を適用せず、`us-east-1`、x86-64、Lambda 2 GB、Lambda
`$0.0000166667 / GB-second`、request `$0.20 / 100万回`、ECR
`$0.10 / GB-month`、REST API `$3.50 / 100万回`で計算した。実測imageは
276.12 MiBで、ECRは約`$0.02895 / 月`である。円換算は余裕を持たせて
1ドル160円、さらに税等10%を加えた。

| 状況 | 前提 | 無料枠適用前の月額概算 |
| --- | --- | ---: |
| 通常 | 100回、Lambda warm p95 1.975秒 | 約`$0.04`／約7円 |
| 繁忙 | 1,000回、Lambda warm p95 1.975秒 | 約`$0.10`／約18円 |
| 濫用上限 | 3,000回すべてが20秒実行、authorizerと最大1 MB応答を含む | 約`$2.10`／約370円 |

CloudFront Free定額プランでは、月100万request、100 GB transfer、S3 5 GB creditの範囲を
0ドルとし、超過課金もない。通常・繁忙利用はLambdaの恒久無料枠内にも収まる可能性が高いが、
上表では考慮していない。ログへrequest／response本文を出さず、1件あたりの運用ログを
2 KB未満、保持14日とし、月500円までの余裕を残す。

残余リスクは、usage quotaを超えるbest-effort処理、AWS以外の同一account利用量、為替・税、
料金改定、CloudFrontを迂回したAPI Gatewayへの大量requestである。WAF、origin確認header、
authorizer、reserved concurrency、予算通知を重ねるが、月500円を金融上のhard capとしては
保証しない。

## 7. デプロイ、監視、復旧

- 静的assetとLambdaは同じrelease IDで追跡し、互換schema versionを明記する。
- 静的assetはversion付き成果物を保持し、前releaseを再配置してCloudFrontをinvalidateできるようにする。
- Lambdaはversionとaliasで公開し、smoke test成功後にaliasを切り替える。失敗時は前versionへ戻す。
- CloudWatchでinvocation、error、duration、throttle、max memory、authorizer拒否数を監視する。
- WAFとCloudFrontでは遮断数とAPI pathのrequest数を監視する。大会名、チーム名、入力、結果は記録しない。
- Lambda logはJSON形式の最小項目にし、保持14日とする。通常時にdebug logを有効化しない。
- API障害中もService WorkerとIndexedDBから保存済み結果を表示し、生成だけが利用できないと日本語で示す。
- ブラウザ保存の消失はJSON backupから復元する。サーバー側backupは持たない。

## 8. 切替条件

次のいずれかが成立した場合は、このADRを再評価する。

- CloudFront Free定額プランを対象accountで利用できない場合は、Cloudflare Pages Freeへ切り替える。
- 日本からのend-to-end p95が20秒を超える場合は、`ap-northeast-1`を同じ入力で比較する。
- 最大32チームの本番相当入力が30秒以内に完了しない場合は、Lambda memory、Cloud Run、非同期化を再比較する。
- 月3,000回、同時利用3人、月500円のいずれかを継続的に超える場合は、認証と厳密なquota保存を検討する。
- 共同編集、公開URL、クラウド保存が必要になった場合は、認証・DB・データ移行を含む別ADRを作る。
- 公式のOR-Tools browser／WASM配布が利用可能になり、32チームで性能と再現性を満たす場合はbrowser内求解を再評価する。

## 9. 維持する抽象化境界

- 大会規則、Pydantic model、solver、独立validatorはHTTPやcloud SDKへ依存させない。
- `application.handle_request`相当のJSON互換境界を、Lambda、Cloud Run、browser adapterから再利用する。
- frontendはprovider固有URLではなく、同一originの`/api/v1/schedules:generate`だけを参照する。
- IndexedDBの保存documentとJSON exportは同じschema versionを持たせ、cloud provider変更で移行させない。
- WAF、API Gateway、Lambda eventなどtransport固有形式は薄いadapter内で正規化する。

## 10. 公式資料

確認日はいずれも2026年8月5日である。

- [GitHub Pagesの制限](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- [Cloudflare Pagesの料金](https://developers.cloudflare.com/pages/functions/pricing/)
- [Cloudflare Pagesの制限](https://developers.cloudflare.com/pages/platform/limits/)
- [CloudFront定額プラン](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html)
- [CloudFrontからoriginへ追加するcustom header](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/add-origin-custom-headers.html)
- [AWS Lambda料金](https://aws.amazon.com/lambda/pricing/)
- [AWS Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
- [API Gateway料金](https://aws.amazon.com/api-gateway/pricing/)
- [API Gatewayのthrottling](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html)
- [API Gateway Lambda authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-use-lambda-authorizer.html)
- [Lambda reserved concurrency](https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html)
- [Amazon ECR料金](https://aws.amazon.com/ecr/pricing/)
- [AWS Budgets料金](https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/)
- [Cloud Run料金](https://cloud.google.com/run/pricing)
- [Cloud Runの制限](https://docs.cloud.google.com/run/quotas)
- [Cloudflare Turnstileの料金](https://developers.cloudflare.com/turnstile/plans/)
- [Turnstileのserver-side検証](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [OR-Tools Pythonの対応platform](https://developers.google.com/optimization/install/python)
- [OR-Tools browser buildのfeature request](https://github.com/google/or-tools/discussions/2997)
