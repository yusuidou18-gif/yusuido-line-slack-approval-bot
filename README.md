# 湧水堂 公式LINE返信支援AI

LINEで届いた顧客メッセージを受け取り、Google Drive / Googleカレンダーを確認し、Slackへ返信案の承認依頼を出すNode.jsアプリです。

通常問い合わせは担当者または社長の承認で公式LINEへ返信します。クレーム、緊急、金額、返金、法的・口コミリスクなど社長確認が必要な内容は、社長承認後のみ送信します。

## できること

- LINE Webhookで顧客メッセージを受信
- Google Drive内の案件候補ファイルを検索
- Google Drive内の `湧水堂_案件管理` シートを優先して案件情報を確認
- Googleカレンダーの予定を確認
- 会社ルールに基づいて緊急度と社長確認要否を判定
- Slackへ返信案、判断理由、確認者を投稿
- Slackの承認ボタンで承認を記録
- 通常問い合わせは1承認でLINEへプッシュ送信
- 社長確認が必要な問い合わせは社長承認後のみLINEへプッシュ送信
- 修正依頼ボタンから修正文を入力し、再承認依頼を投稿
- 却下時はLINE送信せず履歴に記録
- 新しいLINEメッセージ受信時は古い未送信下書きを無効化
- 曜日、日付、時間帯の希望を読み取り、Googleカレンダーの空き枠に合う候補だけを返信案に反映
- 承認履歴を `data/approval-requests.json` に保存
- `DATABASE_URL` がある場合はPostgresに保存
- `/health/deep` で設定不足、未処理件数、送信失敗件数を確認

## ファイル構成

```text
src/
  server.js    Webhookサーバー本体
  rules.js     緊急度判定と返信案作成ルール
  slack.js     Slack投稿、承認ボタン、修正モーダル
  line.js      LINE送信
  google.js    Google Drive / Calendar連携
  storage.js   承認依頼のローカル保存
  audit.js     監査ログ
  draft.js     返信案検証
  llm.js       LLM返信案生成
  security.js  LINE / Slack署名検証
  config.js    環境変数読み込み
```

## 起動方法

`.env.example` を参考に `.env` を作成し、各サービスの値を設定します。

```powershell
node src/server.js
```

PowerShellで `npm` が実行ポリシーにより止まる環境でも動くよう、依存パッケージは使っていません。

## Webhook URL

公開URLが `https://example.com` の場合、各サービスには以下を設定します。

LINE Messaging API Webhook:

```text
https://example.com/webhooks/line
```

Slack Interactivity Request URL:

```text
https://example.com/webhooks/slack/actions
```

ヘルスチェック:

```text
https://example.com/health
```

詳細ヘルスチェック:

```text
https://example.com/health/deep
```

## LINE側の設定

LINE DevelopersでMessaging APIチャネルを作成し、以下を `.env` に設定します。

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`

Webhook URLには `/webhooks/line` を登録してください。

承認後の送信は、返信トークンではなくPush Messageを使います。Slack承認に時間がかかっても送れるようにするためです。

## Slack側の設定

Slack Appを作成し、以下を設定します。

- Bot Token Scopes: `chat:write`
- Interactivity & Shortcuts: On
- Request URL: `/webhooks/slack/actions`

`.env` には以下を設定します。

- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN`
- `SLACK_CHANNEL_ID`
- `SLACK_PRESIDENT_USER_ID`
- `SLACK_OFFICE_USER_ID`
- `SLACK_STAFF_USER_IDS`

`SLACK_STAFF_USER_IDS` は担当者名とSlackユーザーIDの対応表です。

```json
{"佐藤":"U1111111111","田中":"U2222222222"}
```

案件担当者が特定できない場合は、事務担当と社長に通知します。

## Google側の設定

Google Cloudでサービスアカウントを作成し、DriveとCalendarの読み取り権限を付与します。

必要なAPI:

- Google Drive API
- Google Calendar API

`.env` には以下を設定します。

- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_DRIVE_FOLDER_ID`
- `GOOGLE_CASE_SHEET_NAME` 省略時は `湧水堂_案件管理`
- `GOOGLE_CALENDAR_IDS`

Google Driveの対象フォルダは、サービスアカウントに共有してください。Googleカレンダーも同様にサービスアカウントへ共有が必要です。

`湧水堂_案件管理` には、可能であれば以下の列を用意してください。

```text
案件ID
顧客名
LINEユーザーID
電話番号
住所
新規/OB
担当者
ステータス
見積提出済み
工事予定
クレーム履歴
最終更新日
備考
```

## 保存先

本番ではPostgres利用を推奨します。Render PostgreSQL、Neon、Supabaseなどで発行される `DATABASE_URL` をRenderの環境変数に設定すると、承認依頼、会話履歴、顧客紐づけがDB保存に切り替わります。

`DATABASE_URL` が未設定の場合は、従来通り `data/*.json` に保存します。これはローカル検証や小規模テスト用です。

## LLM設定

`OPENAI_API_KEY` を設定すると、ルールベースの返信案と案件/日程情報をもとにLLMで返信案を整えます。

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.4-mini
REQUIRE_LLM=false
```

`REQUIRE_LLM=true` にすると、LLM生成に失敗した場合はSlack上で送信不可になります。最初の運用では `false` にして、ルールベース返信を保険として残すことを推奨します。

## 承認ルール

LINE送信には以下が必要です。

- 通常問い合わせ: 担当者または社長の承認
- 社長確認が必要な問い合わせ: 社長の承認
- 修正依頼が未解決ではないこと
- 却下されていないこと
- 最新の下書きであること
- 下書き検証に通っていること
- LINE送信前に送信処理が確保できていること

社長確認が「不要」と判定された通常問い合わせでは、Slackの承認者欄に社長は表示しません。社長確認が「必要」の場合だけ社長を承認者として表示します。

Slackで承認後、前回提示候補をお客様が選んだケースでは、送信直前にGoogleカレンダーを再確認します。候補枠が埋まっていた場合はLINE送信を止め、Slackに再提案が必要な旨を追記します。

## 運用前チェック

変更後は必ず以下を実行してください。

```powershell
npm.cmd run test:all
npm.cmd run validate:env
```

`validate:env` がNGの場合、Render側の環境変数に不足がないか確認してください。

## 障害時

- Slack通知が来ない: Render Logsで `/webhooks/line` の受信とSlack APIエラーを確認
- 承認してもLINEが届かない: Slack通知のステータス追記、`/health/deep` の `sendFailures`、Render Logsを確認
- 古い通知を押した: `stale` と表示され、LINE送信は止まります
- 日程候補が埋まった: `slot_unavailable` となり、再提案が必要です
- 重大障害時: LINE DevelopersでWebhookを一時停止し、Slack確認後に手動返信へ切り替え

## 修正依頼

Slackの［修正依頼］を押すと、修正後の返信案を入力するモーダルが開きます。

送信すると以下を行います。

- 返信案を更新
- 担当者承認と社長承認をリセット
- Slackに再度承認依頼を投稿

## 注意点

- 金額、工期、値引き、対応可否は確約しない文面にしています。
- Google Driveの案件情報はファイル検索までの実装です。顧客名、案件ID、担当者などを厳密に抽出するには、案件台帳の形式に合わせたパーサー追加が必要です。
- 本番公開にはngrok、Cloud Run、Render、VPSなどでHTTPS公開が必要です。
- LINEのPush Messageを使うため、LINE側の友だち追加状態や送信権限が必要です。

## 次に決めること

- 緊急時に案内する正式な電話番号
- Slack投稿先チャンネル
- 社長、事務担当、各担当者のSlackユーザーID
- Google Drive内の案件台帳の形式
- Googleカレンダーの対象カレンダー
- 本番のホスティング先

## 便利コマンド

構文チェック:

```powershell
node scripts/check-syntax.js
```

環境変数チェック:

```powershell
node scripts/validate-env.js
```

返信判定の簡易テスト:

```powershell
node scripts/smoke-test.js
```

本番接続に必要な情報は `outputs/production_setup_sheet.md` にまとめています。

## Renderに公開する場合

このリポジトリには `render.yaml` を用意しています。RenderではWeb Serviceとして作成し、以下で起動します。

```text
node src/server.js
```

Health Check Path:

```text
/health
```

Renderの公開URLが決まったら、環境変数 `PUBLIC_BASE_URL` に以下のように設定します。

```text
https://line-ai.yusuidou.com
```

DNS反映前にRenderの仮URLで動作確認する場合は、いったんRenderが発行する `https://xxxxx.onrender.com` を設定しても構いません。
