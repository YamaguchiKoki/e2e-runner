---
id: login-systemadmin-001
target: ${TARGET_URL}
account: SYSTEM_ADMIN
issueRepo: yaichi-tech/strike-hyperion
timeoutSec: 120
tags: [smoke, auth]
---

## 手順
1. ログインページを開く
2. メール `admin@example.com` とパスワードを入力
3. 「ログイン」ボタンを押す

## 期待結果
- ダッシュボード画面 (`/dashboard`) に遷移する
- ヘッダーに「システム管理者」の文字が表示される
