# 湧水堂 公式LINE返信支援AI 運用PDCA

## 目的

LINE対応の返信品質を安定させ、担当者が安心して承認できる状態を維持する。

## 毎日見ること

- LINE受信件数
- Slack承認依頼件数
- 承認済み送信件数
- 送信失敗件数
- `pending` のまま30分以上残っている件数
- `generation_failed` の件数
- `slot_unavailable` の件数
- Google Driveで案件未特定になった件数
- Googleカレンダー候補が出なかった件数

確認URL:

```text
/health/deep
```

## 週1回見ること

- 修正依頼された返信案を10件確認
- 修正理由を分類
- 誤判定したカテゴリを確認
- 日程調整で候補が出なかった文面を確認
- クレーム/値引き/返金/緊急判定の漏れを確認
- 案件管理シートの列や入力ゆれを確認

## 改善分類

| 分類 | 例 | 改善先 |
| --- | --- | --- |
| 日時理解 | 16時半、来週土曜、午前中 | `src/google.js` |
| 返信文 | 丁寧さ不足、長い、分かりにくい | `src/rules.js` |
| 承認導線 | 誰が見ればよいか不明 | `src/slack.js` |
| 案件特定 | 顧客名だけで複数候補 | `湧水堂_案件管理` / `src/google.js` |
| 安全性 | 古い下書き、二重送信 | `src/server.js` / `src/storage.js` |

## 変更時の手順

1. 実例を1件選ぶ
2. 期待するSlack通知とLINE返信案を書く
3. `scripts/regression-tests.js` にテストを追加
4. コードを修正
5. `npm.cmd run test:all` を実行
6. GitHubへpush
7. Renderデプロイ後に本番LINEで1件テスト

## ロールバック

重大な不具合が出た場合:

1. LINE DevelopersでWebhookを一時停止
2. Renderで直前の成功デプロイに戻す
3. Slackに手動対応へ切替の連絡を出す
4. `data/audit-log.ndjson` またはDB上の監査ログで対象requestIdを確認
5. 原因を修正し、テスト追加後に再デプロイ

## 現時点の残課題

- Render本番に `DATABASE_URL` を設定してPostgres保存へ切り替える
- `湧水堂_案件管理` の列名を上記READMEの推奨列にそろえる
- Google Calendarへの仮押さえ登録は未実装
- LLM API連携は任意実装済み。`OPENAI_API_KEY` 未設定時はルールベース生成で継続
- `REQUIRE_LLM=true` の本番運用にする前に、実例20件程度で返信品質を確認する
- Slackアクションの完全非同期ジョブ化は未実装
