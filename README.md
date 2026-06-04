# AI Pose Analyzer

LINE LIFF × MediaPipe Pose × Google Apps Script で構成される、サーバーレスの姿勢評価システム。

患者のスマートフォン端末上で姿勢解析（エッジAI処理）を行い、結果のみを暗号化してGoogle Apps Script経由でスプレッドシートに保存する。生画像は外部に送信しない設計。

## ディレクトリ構成

```
.
├── docs/
│   └── plan.md            # 開発・運用計画書
├── liff/                   # LIFFアプリ（フロントエンド）
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── app.js          # 画面遷移・カメラ・GAS通信
│       ├── pose.js         # MediaPipe Pose による姿勢解析
│       └── config.js       # LIFF ID / GAS Web App URL
└── gas/                    # Google Apps Script（バックエンド）
    ├── Code.gs             # doPost / doGet エントリポイント
    ├── Auth.gs             # LINE IDトークン検証
    ├── Store.gs            # スプレッドシート保存・履歴取得
    └── appsscript.json     # GASマニフェスト
```

## セットアップ

詳細は `docs/plan.md` を参照。要点：

1. **LIFF チャネル作成**: LINE Developers で LIFF アプリを作成し、エンドポイントURLに本リポジトリのホスティング先を指定。
2. **GAS プロジェクト作成**: `gas/` 配下のファイルを Apps Script プロジェクトにコピー。Web App としてデプロイ（実行: 自分、アクセス: 全員）。
3. **設定値の反映**:
   - `liff/js/config.js` に LIFF ID と GAS Web App URL を記入。
   - GAS のスクリプトプロパティに `LINE_CHANNEL_ID`（LIFFチャネルID）と `SHEET_ID`（保存先スプレッドシートID）を登録。
4. **動作確認**: LINE 上で LIFF を開き、撮影→解析→保存→履歴閲覧 が成立することを確認。

## セキュリティ設計

- 生画像は外部送信しない（端末内でランドマーク座標とスコアに変換）
- LINE ID トークンを GAS 側で `https://api.line.me/oauth2/v2.1/verify` で検証
- スプレッドシートには LINE ユーザーID（英数字）と姿勢データのみ保存
- 保存先 Drive は院の管理者のみアクセス可能とし、公開URLは発行しない
