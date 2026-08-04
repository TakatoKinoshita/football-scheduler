# ADR-0002: Cloudflare Pagesによる公開入口の代替

- 状態: 採用（AWS Lambda quotaの増枠完了まで公開不可）
- 決定日: 2026-08-05
- 置換対象: ADR-0001の静的配信、公開入口、WAF
- 関連: issue #6、#7、#8、#9

## 1. 確認結果

対象AWS accountで読み取り確認を行い、次が判明した。

- AWS Free Tier account planを利用中であり、CloudFront Free定額プランへ加入できない。
- CloudFront Free plan使用数は`0 / 3`だが、account plan条件を満たさないため利用数の余裕は採否を変えない。
- Lambda account同時実行quotaは`10`である。AWS Lambdaはreserved concurrencyを設定する場合も
  100を未予約で残すため、solverとauthorizerへ各3を予約するには`3 + 3 + 100 = 106`以上必要である。
- CloudFront画面上の直近利用量・distribution適格性確認は、CloudFrontを採用しないため本構成の公開条件から外す。

したがって、従量課金CloudFrontへ暗黙に切り替えず、ADR-0001に定めた代替条件を発動する。
Lambda quota不足は静的配信方式では解消しないため、増枠完了まで本番公開を停止する。

## 2. 決定

MVPの公開入口を次の構成へ変更する。

- TypeScript／Vite PWAはCloudflare Pages Freeから静的配信する。
- ブラウザは同一originの`POST /api/v1/schedules:generate`だけを呼ぶ。
- 同pathのPages Functionを、AWS API Gatewayへの薄い非永続proxyとする。
- `AWS_API_ORIGIN`、origin確認値、API Gateway usage keyはPages Functionの暗号化secretに保存し、browser bundleへ含めない。
- Pages Functionはmethod、content type、1 MB上限を検証し、browserの`Origin`、Turnstile token、Cloudflareが付与した接続元IPだけをAWSへ転送する。
- Turnstile tokenは単回利用のためPages Functionでは検証せず、AWS Lambda authorizerで1回だけ検証する。
- AWS側はAPI Gateway、authorizer Lambda、solver Lambda、ECR、CloudWatch、Budgetsだけとし、S3、CloudFront、WAFを本番templateから除く。
- 大会入力と生成結果はPages Function、API Gateway、Lambdaのいずれにも永続保存しない。

```text
browser / PWA / IndexedDB
          |
          | same-origin POST、Turnstile token、最大1 MB
          v
Cloudflare Pages Function
          |
          | origin確認secret、usage keyを付与
          v
API Gateway -> Lambda authorizer -> solver Lambda
```

## 3. 代替案の再評価

必須条件は30秒以内、月500円程度、最大32チーム、サーバー側非永続化である。採点軸と重みは
ADR-0001と同じで、5点満点とした。

| 候補 | 運用 30% | 濫用対策 25% | 費用 20% | 性能 15% | 移行性 10% | 加重点 | 判断 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Cloudflare Pages＋Pages Function proxy | 4 | 4 | 5 | 4 | 4 | **4.20** | 採用 |
| GitHub Pages＋browserからAPI Gatewayを直接呼出し | 4 | 2 | 5 | 4 | 5 | 3.85 | usage keyとorigin secretを公開せず同一origin化できない |
| GitHub Pages＋別Cloudflare Worker proxy | 3 | 4 | 5 | 4 | 4 | 3.90 | 配信とproxyが別projectになり運用対象が増える |
| S3＋従量課金CloudFront | 3 | 4 | 3 | 4 | 4 | 3.55 | 無料定額の超過課金なしという費用境界を失う |

PagesとFunctionを同じprojectに置くことで、利用者には単一URLだけを示し、preview、release、
rollbackも1単位にできる。API keyをJavaScriptへ埋め込まないため、GitHub Pagesからの直接呼出し
より濫用耐性が高い。Cloudflare accountは追加されるが、CloudFront plan適格性への依存を除ける。

## 4. 無料枠、上限、費用

公式資料を2026年8月5日に確認した。

- Pagesの静的asset requestとbandwidthは無料・無制限である。
- Pages FunctionsはWorkers Free枠を使い、1日100,000 requestである。
- Free planは月500 build、20,000 files、1 file 25 MiBまでである。
- `_routes.json`を`/api/*`だけに限定し、静的asset閲覧でFunctions枠を消費しない。
- Functions枠超過時はfail closedにし、APIの保護処理を迂回させない。静的画面まで停止するため、PWA cacheとIndexedDBによる保存済み結果の閲覧を復旧経路とする。

API Gatewayの月3,000 accepted generation上限は、通常100回、繁忙1,000回より十分大きく、
Pages Functionsの日次枠より先にAWS usage planが制限する。Cloudflare側のMVP固定費は0円であり、
AWS計算部分の試算はADR-0001の通常約7円、繁忙約18円、濫用上限約370円を維持する。
quotaはbest-effortであり、月500円を金融上のhard capとして保証するものではない。

## 5. セキュリティと運用境界

- Pages static routeにはCSP、HSTS、frame拒否、MIME sniffing拒否を設定する。
- Pages Functionには`/api/*`だけを割り当て、API以外のpathをAWSへ転送しない。
- Pages Function secretはGitHub、Cloudflare、AWSのログへ出力しない。
- AWS API Gatewayへの直接requestはorigin確認secretとusage keyがないため拒否する。
- Turnstile、API Gateway throttle、月3,000回quota、Lambda reserved concurrency 3を重ねる。
- CORSは認証や濫用対策として利用しない。
- CloudflareとAWSのログに大会名、チーム名、request／response本文を記録しない。
- Cloudflare Pages deploymentとLambda versionを同じrelease ID／commit SHAで追跡する。

CloudFront WAFのIP rate ruleは失われる。MVPではTurnstile、全体throttle、月間quota、同時実行上限を
優先し、Cloudflare側のrequest分析で濫用が観測された場合にrate limitingを別途再評価する。

## 6. 公開条件と切替条件

公開前に次をすべて満たす。

- Lambda account同時実行quotaを106以上へ増枠する。運用余裕を含む申請値は110以上を推奨する。
- Cloudflare Pages Direct Upload project、Pages Write API token、production branchを設定する。
- Pages Functionsの3 secretとTurnstile hostname／actionを設定する。
- Functions枠超過時の動作をfail closedにする。
- GitHub `production` Environmentのreviewer、AWS OIDC、予算通知を設定する。
- 公開release workflowの品質検査、Lambda smoke test、公開app shell smoke testを通す。

次の場合は再評価する。

- Pages Functionsの日10万回または月500 buildへ継続的に近づく。
- Cloudflare障害・仕様変更がオフライン閲覧や月500円要件を満たさなくする。
- IP単位の厳密なrate limitや利用者認証が必要になる。
- AWS account planが変わっても、それだけを理由にCloudFrontへ戻さない。運用実績と移行費用を同じ軸で再比較する。

## 7. 公式資料

確認日はいずれも2026年8月5日である。

- [Pages Functionsの料金と無料枠](https://developers.cloudflare.com/pages/functions/pricing/)
- [Cloudflare Pagesの制限](https://developers.cloudflare.com/pages/platform/limits/)
- [Pages Functionsのroutingとfail open／closed](https://developers.cloudflare.com/pages/functions/routing/)
- [WranglerによるDirect Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- [Direct UploadのCI利用](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)
- [Pages Functionsのsecret](https://developers.cloudflare.com/pages/functions/bindings/)
- [Cloudflare Pages rollback](https://developers.cloudflare.com/pages/configuration/rollbacks/)
- [Cloudflare Pages rollback API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/rollback/)
- [Lambda reserved concurrency](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)
- [Lambda concurrency監視](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-concurrency.html)
