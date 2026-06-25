# 湧水堂 公式LINE返信支援AI 本番接続セットアップシート

## 1. こちらで実装済みの範囲

以下は実装済みです。

- LINE Webhook受信
- LINE署名検証
- Slack承認依頼投稿
- Slack署名検証
- Slack承認ボタン
- Slack修正依頼モーダル
- 担当者承認と社長承認の両方が揃った場合のみLINE送信
- 却下時の送信停止
- Google Drive検索
- Googleカレンダー予定取得
- 緊急度判定
- 社長確認要否判定
- 返信案作成
- 承認履歴保存
- 環境変数チェック
- スモークテスト

## 2. 実運用に必要な情報

以下を埋めると本番接続できます。

### 2.1 会社情報

| 項目 | 値 |
|---|---|
| 緊急時に案内する電話番号 |  |
| 営業時間 |  |
| 定休日 |  |
| 営業時間外の案内文 |  |

### 2.2 LINE

| 項目 | 値 |
|---|---|
| LINE Channel Secret |  |
| LINE Channel Access Token |  |
| LINE Webhook URL | `https://本番ドメイン/webhooks/line` |

LINE Developersで以下を設定してください。

- Messaging APIチャネルを作成
- Webhookを有効化
- Webhook URLに `https://本番ドメイン/webhooks/line` を登録
- Channel secretを取得
- Channel access tokenを発行

### 2.3 Slack

| 項目 | 値 |
|---|---|
| Slack Signing Secret |  |
| Slack Bot Token |  |
| 投稿先チャンネルID |  |
| 社長SlackユーザーID |  |
| 事務担当SlackユーザーID |  |
| 担当者名とSlackユーザーID |  |
| Slack Interactivity URL | `https://本番ドメイン/webhooks/slack/actions` |

Slack Appで以下を設定してください。

- Bot Token Scopeに `chat:write` を追加
- 対象ワークスペースへアプリをインストール
- Bot User OAuth Tokenを取得
- Interactivity & Shortcutsを有効化
- Request URLに `https://本番ドメイン/webhooks/slack/actions` を登録
- 投稿先チャンネルにBotを招待

担当者名とSlackユーザーIDの形式:

```json
{"佐藤":"U1111111111","田中":"U2222222222"}
```

### 2.4 Google

| 項目 | 値 |
|---|---|
| Google Service Account Client Email |  |
| Google Service Account Private Key |  |
| Google Drive案件フォルダID |  |
| Google Calendar ID一覧 |  |

Google Cloudで以下を設定してください。

- Google Drive APIを有効化
- Google Calendar APIを有効化
- サービスアカウントを作成
- JSONキーを発行
- 案件フォルダをサービスアカウントのメールアドレスに共有
- 対象カレンダーをサービスアカウントのメールアドレスに共有

Google Calendar ID一覧の形式:

```json
["primary","staff@example.com"]
```

## 3. `.env` への反映

`.env.example` をコピーして `.env` を作成し、上記の値を入れます。

```text
PORT=3000
PUBLIC_BASE_URL=https://本番ドメイン
COMPANY_PHONE=電話番号
BUSINESS_HOURS_TEXT=営業時間

LINE_CHANNEL_SECRET=...
LINE_CHANNEL_ACCESS_TOKEN=...

SLACK_SIGNING_SECRET=...
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_ID=C...
SLACK_PRESIDENT_USER_ID=U...
SLACK_OFFICE_USER_ID=U...
SLACK_STAFF_USER_IDS={"佐藤":"U..."}

GOOGLE_CLIENT_EMAIL=...
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_DRIVE_FOLDER_ID=...
GOOGLE_CALENDAR_IDS=["primary"]
```

## 4. 接続確認コマンド

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

サーバー起動:

```powershell
node src/server.js
```

ヘルスチェック:

```powershell
curl.exe http://127.0.0.1:3000/health
```

期待される応答:

```json
{"ok":true,"service":"yusuido-line-slack-approval-bot"}
```

## 5. 本番公開先の候補

本番運用にはHTTPSの公開URLが必要です。

候補:

- Google Cloud Run
- Render
- Railway
- VPS
- ngrok 有料固定ドメイン

推奨はGoogle Cloud Runです。Google連携との相性がよく、HTTPS公開もしやすいためです。

## 6. 追加で決めたい運用ルール

以下は実装後の運用品質に関わるため、最初に決めておくのがおすすめです。

- 営業時間外に緊急案件が来た場合の電話案内文
- 社長が不在の場合の代理承認者
- 担当者が未定の場合の一次確認者
- クレーム履歴がある顧客の通知先
- 案件台帳の正式な項目名
- Google Drive内の案件検索キー
- 承認履歴をローカルJSONのままにするか、Google Sheetsなどへ保存するか

## 7. こちらに共有してほしい情報

実際に本番接続までこちらで続ける場合は、以下を共有してください。

- 本番公開先をどこにするか
- 緊急時に案内する電話番号
- Slack投稿先チャンネルID
- 社長のSlackユーザーID
- 事務担当のSlackユーザーID
- 担当者名とSlackユーザーIDの一覧
- Google Driveの案件フォルダID
- Google Calendar ID一覧
- LINE Channel Secret
- LINE Channel Access Token
- Slack Signing Secret
- Slack Bot Token
- GoogleサービスアカウントJSONの内容

秘密情報を共有する場合は、通常のチャットではなく安全な方法で管理してください。
