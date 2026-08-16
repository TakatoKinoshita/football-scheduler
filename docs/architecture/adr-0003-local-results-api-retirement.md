# ADR-0003: 結果計算の端末内確定と公開APIの廃止

- 状態: 採用
- 決定日: 2026-08-16
- 対象: schema `0.2.0`の結果入力と順位確定
- 関連: issue #112、#113、#114

## 1. 背景

大会データの正本はブラウザのIndexedDBであり、サーバーは大会データを永続保存しない。
Issue #112と#113により、1日目リーグ、2日目同順位リーグ、順位決定トーナメントの結果検証と
順位確定はブラウザ内でPython実装と同じ保存JSONを生成できるようになった。現行PWAは結果確定時に
公開APIやTurnstileを使わないため、結果計算専用の公開経路は攻撃面、運用対象、release smokeの
重複になっている。

一方、Service Workerで旧JavaScriptを開いたままの利用者は、更新するまで旧結果計算APIを呼ぶ
可能性がある。移行時に保存データを失わないことと、不要な公開計算経路を恒久的に残さないことの
両方を満たす必要がある。

## 2. 決定

- 結果検証と順位確定は、3形式ともブラウザ内を正規経路とする。
- 公開API、Pages Function、Lambda authorizer、Lambda HTTP adapterから次の結果計算経路を削除する。
  - `league_standings` / `calculate_standings`
  - `tournament_results` / `calculate_tournament_results`
  - `same_rank_league_results` / `calculate_same_rank_results`
- 日程、決勝計画、2日目日程を生成する公開経路は維持し、Turnstile、origin確認、API key、
  throttle、月間quota、reserved concurrency、ログ、alarm、予算通知を引き続き適用する。
- Pythonの順位計算実装と`application.handle_request`のJSON互換境界は削除しない。生成処理の内部利用、
  保存schemaの正本、Python／TypeScriptのgolden fixture比較に利用する。
- 結果計算専用のLambda smokeは廃止し、本番smokeは公開責務である日程生成と独立制約検証を確認する。

## 3. 互換性期間

Issue #112と#113を含むrelease `4312c96a60139ef8ff278bb5627109dfe211977f`を、結果計算APIを
残した1リリースの移行期間とする。このreleaseでは新PWAが結果計算APIを呼ばない状態を本番へ反映し、
旧PWAだけが互換経路を利用できた。次のコードreleaseで結果計算用の公開actionを削除する。

PWAは待機中のService Workerを検知すると同じ画面内で1回更新を案内し、承認時は入力を保存して
Service Workerを有効化してから再読込みする。更新を見送った旧PWAは結果計算要求を拒否されるため、
画面を再読込みして更新する必要がある。IndexedDBの大会データとJSON backupはAPI廃止の影響を
受けず、更新のために削除しない。

## 4. 影響

- 通信障害やTurnstile障害中でも、保存済み日程への結果入力と順位確定を継続できる。
- 結果確定のためのPages Function、authorizer、Lambda呼出しと使用量を削減できる。
- 公開APIの濫用対策と費用監視は、CPU負荷が高い生成処理へ限定して維持できる。
- API廃止前の旧PWAには更新が必要になるが、大会データの移行やschema変更は不要である。
- Pythonの内部ドメイン処理を残すため、日程・決勝計画生成とクロス実装の回帰検証は継続できる。

## 5. 再評価条件

利用者アカウント、サーバーを正本とする大会保存、共同編集、所有者が管理する公開リンクのいずれかを
導入する場合は、順位の正規計算場所、競合解決、監査履歴、再計算方法を別ADRで決定する。
