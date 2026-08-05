# MVP本番リリース・監視・復旧手順

## 1. この手順の位置づけ

本番構成はCloudflare Pages／Pages Functionsと、`us-east-1`のAPI Gateway、Lambda、ECR、
CloudWatch、AWS Budgetsを使用する。大会データはbrowserのIndexedDBとJSONファイルだけに
保存し、CloudflareとAWSには永続保存しない。

現時点では本番リソースを作成・公開していない。対象AWS accountのLambda同時実行quotaは
2026年8月5日に`1000`と確認できており、必要値`106`以上の条件を満たしている。quotaによる
公開blockerは解消済みである。

本番templateは[infra/production/template.yaml](../../infra/production/template.yaml)、初回だけ必要な
AWS OIDC role、CloudFormation実行role、ECR、SAM artifact bucketは
[infra/production/bootstrap.yaml](../../infra/production/bootstrap.yaml)で管理する。技術検証用の
ルート`template.yaml`とは別stackにする。

## 2. 公開前の必須確認

### 2.1 AWS accountとLambda quota

次のread-only確認を行う。

```console
uv run python scripts/check_production_prerequisites.py --hosting cloudflare-pages
```

AWS Lambdaはreserved concurrencyを設定する場合も100を未予約で残す。solverとauthorizerへ
それぞれ3を予約するため、account同時実行quotaは`3 + 3 + 100 = 106`以上必要である。現在値は
`1000`であり、上記scriptで合格を確認済みである。公開前とquota変更後は同じread-only確認を
再実行し、reserved concurrencyを外して費用・同時実行ガードを弱めない。

AWS Console上の対象は`AWS Lambda`の`Concurrent executions`（quota code `L-B99A9384`）である。
quota増枠自体には利用料は発生しないが、実際の実行には通常のLambda料金が発生する。

### 2.2 Cloudflare Pages

Cloudflare dashboardで次を確認する。

- Workers & PagesのFree planを利用し、Direct Upload projectを作成済みである。
- production branchは`main`として作成している。
- Pages Functionsの利用上限到達時は`fail closed`である。
- Turnstile widgetのhostnameにPagesの公開hostnameを登録し、actionは`generate_schedule`である。
- Pages Writeだけを対象accountへ許可したAPI tokenを発行している。
- `_routes.json`のincludeは`/api/*`だけである。

CloudFront Free plan使用数`0 / 3`とCloudFront画面上の適格性は、この構成では確認不要である。
AWS Free Tier account planでもCloudflare Pagesを利用できる。CloudFront従量課金へ自動的に
切り替えない。

Direct UploadではCloudflare dashboard側のbranch protectionを公開制御として利用できない。
`.github/workflows/production.yml`を`main`からの実行だけに制限し、GitHub `production`
Environmentのdeployment branchも`main`だけにする。Wranglerにも`--branch main`と完全な
commit SHAを渡し、この3か所の一致を確認する。

### 2.3 API Gateway account設定

API GatewayのCloudWatch roleはregion内のaccount共通設定である。既存roleがある場合は、
`infra/production/template.yaml`の`ApiGatewayAccount`が他APIへ与える影響を確認する。競合する
場合は既存roleを再利用するようtemplateを変更し、理由を記録する。

## 3. 初回bootstrap

### 3.1 AWS

1. GitHub Actions用OIDC provider `token.actions.githubusercontent.com`が対象AWS accountに
   存在することを確認する。audienceは`sts.amazonaws.com`とする。
2. GitHub repositoryのOIDC設定とimmutable subjectに使うIDを確認する。

   ```console
   gh api repos/OWNER/REPOSITORY/actions/oidc/customization/sub
   gh api repos/OWNER/REPOSITORY --jq '{owner_id: .owner.id, repository_id: .id}'
   ```

   GitHubのimmutable subjectを使用するrepositoryでは、`sub_claim_prefix`が
   `repo:OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID`形式になっていることを確認する。本番roleが
   許可する完全なsubjectは、このprefixに`:environment:production`を加えた値とする。表示名だけの
   旧形式やワイルドカードを追加して認証エラーを回避してはならない。
3. `bootstrap.yaml`を管理者が`us-east-1`へ一度だけデプロイする。GitHub APIで確認したowner IDと
   repository IDをparameterへ指定する。

   ```console
   aws cloudformation deploy \
     --template-file infra/production/bootstrap.yaml \
     --stack-name football-scheduler-production-bootstrap \
     --region us-east-1 \
     --capabilities CAPABILITY_IAM \
     --parameter-overrides \
       GitHubOidcProviderArn=OIDC_PROVIDER_ARN \
       GitHubOwner=OWNER \
       GitHubOwnerId=OWNER_ID \
       GitHubRepository=REPOSITORY \
       GitHubRepositoryId=REPOSITORY_ID \
       ProductionStackName=football-scheduler-production \
     --no-fail-on-empty-changeset \
     --no-cli-pager
   ```

4. 作成されたroleのpolicyを確認する。
   - GitHub deploy roleの信頼policyは、上記の完全なsubjectとaudience `sts.amazonaws.com`だけを
     許可する。
   - CloudFormation実行roleは、本番templateのresourceに必要なservice操作に加え、SAM transformの
     `cloudformation:CreateChangeSet`を
     `arn:aws:cloudformation:us-east-1:aws:transform/Serverless-2016-10-31`だけへ許可する。
   - 本番templateへresource typeを追加するときは、CloudFormation実行roleの権限も同時に更新する。
5. 出力値をGitHubの`production` Environmentへ登録する。
6. Environmentのdeployment branchを`main`だけにし、required reviewerをrepository所有者にする。
   唯一のcollaborator本人が承認するため、prevent self-reviewは無効にする。

### 3.2 Cloudflare

1. Cloudflareへログインした管理者がDirect UploadのPages projectを作成する。初回作成には
   `cd web && npx wrangler pages project create`を利用できる。
2. Pages Write権限だけを持つAPI tokenを作る。
3. Turnstile widgetを作り、公開hostnameとactionを設定する。
   widgetにはローカル検証用の`localhost`と`127.0.0.1`も登録できるが、本番authorizerは
   `PUBLIC_APPLICATION_URL`のhostnameだけを許可し、ローカルhostnameを受け付けない。
4. Pages projectのSettings > Runtimeでfail closedを選ぶ。

初回release workflowはAWS stackを作成した後、次の3値をPages Function secretへ設定してから
Pagesを配信する。以後も同じ手順で値を同期する。

- `AWS_API_ORIGIN`: stack出力`ApiBaseUrl`
- `ORIGIN_VERIFY_VALUE`: APIへの直接呼出しを拒否する共有secret
- `API_USAGE_KEY`: API Gateway usage plan key

### 3.3 GitHub production Environment

| 種類 | 名前 | 内容 |
| --- | --- | --- |
| secret | `AWS_DEPLOY_ROLE_ARN` | bootstrap出力のGitHub OIDC role ARN |
| secret | `AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN` | bootstrap出力のCloudFormation実行role ARN |
| secret | `ORIGIN_VERIFY_VALUE` | 32文字以上の推測困難な値 |
| secret | `TURNSTILE_SECRET_KEY` | Turnstile Siteverify用secret |
| secret | `PUBLIC_USAGE_API_KEY` | AWSとPages Functionだけで共有するusage key |
| secret | `CLOUDFLARE_API_TOKEN` | 対象Pages projectへのPages Write token |
| secret | `BUDGET_NOTIFICATION_EMAIL` | 予算・alarm通知先。workflow logで個人情報をmaskするためsecretとして登録する |
| variable | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| variable | `CLOUDFLARE_PAGES_PROJECT` | Direct Upload project名 |
| variable | `PUBLIC_APPLICATION_URL` | `https://<project>.pages.dev`等の公開URL。本番Turnstile検証の許可hostnameにも使用する |
| variable | `ECR_REPOSITORY_URI` | bootstrap出力のECR URI |
| variable | `SAM_ARTIFACT_BUCKET` | bootstrap出力のartifact bucket名 |
| variable | `TURNSTILE_SITE_KEY` | browserへ埋め込むTurnstile site key |
| variable | `PRODUCTION_STACK_NAME` | 既定は`football-scheduler-production` |

secret値をチャット、issue、workflow log、commitへ貼り付けない。`PUBLIC_USAGE_API_KEY`は既存名を
維持しているが、代替構成ではbrowserへ公開しない。secret rotationは通常releaseと分けて行い、
AWSとPages Functionを同時に切り替えて疎通確認する。rotation中は旧Lambda versionだけへ戻すと
secretが不一致になるため、旧値を安全に保持した手順を別途準備する。
`BudgetNotificationEmail`もCloudFormationの`NoEcho` parameterとして扱い、stack照会やeventで
通知先を平文表示しない。

## 4. リリース

`.github/workflows/production.yml`は、`plan`と`apply`を別々の手動実行に分ける。どちらもworkflow
自体を`main`から起動し、各実行でGitHub `production` Environmentの承認を受ける。release IDは
常に実行対象の完全な40文字のcommit SHAとし、任意のrelease名は使用しない。

### 4.1 Plan: change setの作成と確認

1. `main`から`operation: plan`を選び、`release_sha`と`change_set_arn`は空欄にする。
2. 影響確認欄を選択し、Environment承認後に実行する。
3. workflowは設定値とquotaを確認し、Python、Web、Pages Function、最大32チーム経路、SAM
   templateを検証する。
4. commit SHAをtagにしたsolver imageをECRへpushし、SAM artifactをS3へuploadする。
5. CloudFormation change setを作成するが実行しない。初回planでは本番stackは
   `REVIEW_IN_PROGRESS`となり、template内のLambda、API Gateway、Budget、SNSなどはまだ作成されない。
6. Actions summaryでECR image digest、change set ARN、release SHA、Action、Logical ID、resource type、
   replacement有無を確認する。秘密parameterはsummaryへ表示しない。

初回planでは全resourceが`Add`で、`Remove`、`Modify`、replacementがないことを必須とする。
change setが`CREATE_COMPLETE`かつ`AVAILABLE`であることを確認し、ARNとrelease SHAをapply用に
記録する。今回の初回dry-runはここで停止し、change setを実行しない。

### 4.2 Apply: 承認済みchange setの実行と公開

applyはplanの確認後に別作業として明示承認を得てから行う。

1. `main`から`operation: apply`を選ぶ。
2. planで表示された完全なcommit SHAを`release_sha`、change set ARNを`change_set_arn`へ指定する。
3. Environmentで再度承認する。
4. workflowはSHAが`main`に含まれること、stack名、region、change set状態、`ReleaseId`を再検証する。
   `DescribeChangeSet`の応答には作成時の`ChangeSetType`が含まれないため、stackが
   `REVIEW_IN_PROGRESS`なら初回`CREATE`、`CREATE_COMPLETE`、`UPDATE_COMPLETE`、
   `UPDATE_ROLLBACK_COMPLETE`なら`UPDATE`として完了待機方法を選ぶ。それ以外の不安定な状態では
   change setを実行しない。
5. change setを実行し、新Lambda `live` aliasを直接invokeしてschemaと独立制約検証を確認する。
6. stack出力とGitHub secretsをPages Function secretへ同期し、Wranglerで静的assetとFunctionを
   同時配信する。
7. 公開画面の`X-Release-Id`とapp shellを確認する。失敗時は直前のPages deploymentとLambda
   aliasへrollbackする。

本番template内のLambda実行roleとAPI Gateway CloudWatch roleは、
`football-scheduler-production-*`形式の明示名を使用する。これによりCloudFormation実行roleの
IAM scope内に限定し、SAMやCloudFormationによる自動生成名の短縮へ依存しない。named IAM resourceを
含むため、planでは`CAPABILITY_NAMED_IAM`を指定する。

### 4.3 Planを取り消す場合

change setを実行しないと決めた場合は、対象stack、region、ARN、状態をread-only確認してから
change setを削除する。

```console
aws cloudformation describe-change-set \
  --change-set-name CHANGE_SET_ARN \
  --region us-east-1 \
  --no-cli-pager
aws cloudformation delete-change-set \
  --change-set-name CHANGE_SET_ARN \
  --region us-east-1 \
  --no-cli-pager
```

初回作成でchange set削除後もstackが`REVIEW_IN_PROGRESS`として残る場合は、stack名と状態を
再確認する。`delete-stack`は回復困難な操作なので、実行前にユーザーの個別の明示承認を得る。

```console
aws cloudformation describe-stacks \
  --stack-name football-scheduler-production \
  --region us-east-1 \
  --no-cli-pager
aws cloudformation delete-stack \
  --stack-name football-scheduler-production \
  --region us-east-1 \
  --no-cli-pager
```

planでpushしたECR imageとSAM artifactは実行resourceではないため、直ちに手動削除しない。
bootstrapで定義したECRの直近10 image保持とS3の30日expirationに委ねる。

### 4.4 初回作成のrollbackが失敗した場合

初回stack作成が`ROLLBACK_FAILED`になった場合は、stack eventsと各resourceの実体をread-onlyで
確認する。権限不足で作成自体に失敗したresourceを、存在確認なしに手動削除してはならない。

修正版を再planする前に、ユーザーの個別承認を得て通常のstack削除を実行する。削除が
`DELETE_FAILED`になった場合だけ、実体が存在しないことを再確認した失敗resourceのLogical IDを
`--retain-resources`へ指定してstack記録を除去する。実体があるresourceはretainで隠さず、削除または
保持の影響を個別に判断する。

browserはAPI keyを持たず、同一originのPages Functionだけを呼ぶ。Pages Functionは1 MB上限を
確認し、origin確認secretとusage keyをAWSへ付与する。Lambda adapterでもdecoded body sizeを
再確認する。Turnstile tokenは単回利用なのでLambda authorizerで1度だけ検証する。

## 5. 監視と費用

CloudWatch Logsの保持期間は14日である。API Gateway access logはrequest ID、resource path、
HTTP status、処理時間、error typeだけを記録する。大会名、チーム名、入力、結果、Turnstile
token、secretは記録しない。Cloudflare側でもrequest body loggingを追加しない。

次を確認する。

- Cloudflare Pages: Functions request／error、日100,000回枠、deployment status
- Lambda: `Errors`、`Duration` p95、`Throttles`、`ConcurrentExecutions`、最大メモリ
- API Gateway: 5xx、4xx、latency、月3,000回usage quota
- AWS Budgets: 月額2.84 USD基準のforecast 50%、actual 80%、actual 100%

既存のaccount全体の月額5 USD Budgetは維持し、本番templateの月額2.84 USD Budgetを別名で
併設する。前者はaccount全体、後者は本アプリの想定費用に対する早期通知として扱う。

費用試算は次で再計算する。

```console
uv run python scripts/estimate_mvp_cost.py --usd-jpy 160 --tax-multiplier 1.10
```

## 6. 障害と費用超過時の停止

100%予算通知、濫用、情報漏えいの疑い、継続的な5xxのいずれかが発生した場合は、Pagesの
静的画面を残したままAPI Gateway keyを無効化する。保存済み日程の閲覧・印刷は継続し、
生成だけを停止する。

```console
aws apigateway update-api-key \
  --api-key API_KEY_ID \
  --patch-operations op=replace,path=/enabled,value=false \
  --region us-east-1 \
  --no-cli-pager
```

Cloudflare Pages Functionsの日次枠に近づいた場合もAPIを先に停止し、fail closedを解除して
保護処理を迂回させない。再開前に原因、予算残額、quota、Turnstile、origin secretを確認する。

## 7. ロールバック

workflowは配信前のproduction deployment IDとLambda alias versionを記録する。公開smoke testが
失敗した場合、Cloudflare Pages rollback APIで直前deploymentへ戻し、Lambda `live` aliasも
直前versionへ戻す。

手動の場合、Cloudflare dashboardのPages project > Deploymentsから成功済みproduction
deploymentを選び、`Rollback to this deployment`を実行する。APIでは次のendpointを使う。

```text
POST /accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/rollback
```

Lambdaは対象を確認してから戻す。

```console
aws lambda get-alias --function-name FUNCTION_NAME --name live --region us-east-1
aws lambda update-alias \
  --function-name FUNCTION_NAME \
  --name live \
  --function-version PREVIOUS_VERSION \
  --region us-east-1
```

aliasの手動変更はCloudFormationとの差分になる。利用者影響を止めた後、直前image digestと
release IDでstackを再デプロイして一致させる。API障害中もPWA cacheとIndexedDBにある保存済み
結果、チーム別予定、印刷画面を利用できる。

## 8. 削除時の注意

Pages project、Turnstile widget、AWS production stack、ECR repository、SAM artifact bucket、
bootstrap stackの削除は回復困難な操作を含む。対象、残すJSON backup、release、費用への影響を
確認し、ユーザーから個別の明示承認を得てから行う。

## 9. 公式資料

確認日は2026年8月5日である。

- [Pages Functionsの料金](https://developers.cloudflare.com/pages/functions/pricing/)
- [Pages Functionsのrouting](https://developers.cloudflare.com/pages/functions/routing/)
- [Wrangler Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- [Direct UploadとCI](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)
- [Pages rollback](https://developers.cloudflare.com/pages/configuration/rollbacks/)
- [Pages rollback API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/rollback/)
- [Lambda reserved concurrency](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)
