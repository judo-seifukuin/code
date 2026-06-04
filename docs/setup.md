# セットアップ手順書（Phase 0: 環境準備）

本書は AI Pose Analyzer を初めて構築する担当者が、外部サービス側の準備とコードへの設定反映を行うための手順を示す。

---

## 0. 必要なアカウント・権限

- Google アカウント（院の代表アカウント推奨。Drive・スプレッドシートの所有者となる）
- LINE Developers アカウント（プロバイダー作成権限が必要）
- LINE 公式アカウント（リッチメニュー設定権限）
- GitHub アカウント（ホスティング先として使う場合）

---

## 1. 保存先スプレッドシートと Drive フォルダの作成

1. Google Drive で本ツール専用のフォルダ（例: `AI Pose Analyzer`）を作成し、共有設定は **「制限付き（管理者本人のみ）」** とする。
2. フォルダ内に空のスプレッドシート（例: `posture_records`）を作成する。シート ID（URL の `/d/...../edit` 部分）を控える → 後で `SHEET_ID` に使用。
3. 同じフォルダの URL を開き、フォルダ ID（URL の `/folders/...` 部分）を控える → 後で `DRIVE_FOLDER_ID` に使用。

> 補足: フォルダの共有設定を「リンクを知っている全員」にしないこと。骨格画像が外部に流出する可能性がある。

---

## 2. Google Apps Script のセットアップ

1. 上記スプレッドシートを開き、`拡張機能 → Apps Script` でエディタを開く。
2. リポジトリの `gas/` 配下のファイルを 1 ファイルずつコピーする：
   - `Code.gs`
   - `Auth.gs`
   - `Store.gs`
   - `Admin.gs`
   - `appsscript.json`（マニフェスト編集を有効にする必要あり: `プロジェクトの設定 → 「appsscript.json」マニフェストファイルをエディタで表示する` にチェック）
3. **スクリプトプロパティの登録** （`プロジェクトの設定 → スクリプトプロパティ`）：
   | キー | 値 |
   | --- | --- |
   | `LINE_CHANNEL_ID` | LINE Developers の LIFF チャネル ID |
   | `SHEET_ID` | 1 で作成したスプレッドシートの ID |
   | `DRIVE_FOLDER_ID` | 1 で作成したフォルダの ID |
4. **デプロイ**:
   - `デプロイ → 新しいデプロイ → ウェブアプリ`
   - 説明: `AI Pose Analyzer API`
   - 次のユーザーとして実行: **自分**（院の代表アカウント）
   - アクセスできるユーザー: **全員**
   - デプロイ後の `ウェブアプリの URL` を控える → 後で `GAS_ENDPOINT` に使用。
5. 動作確認: URL をブラウザで開き `{"ok":true,"service":"AI Pose Analyzer", ...}` が返れば OK。

> 注意: スクリプトを更新した場合は `デプロイ → 既存のデプロイを管理 → 編集 → 新バージョン` を選んで再デプロイすること。同じ URL のまま新バージョンが配信される。

---

## 3. LINE Developers での LIFF チャネル作成

1. https://developers.line.biz/console/ にログイン。
2. プロバイダーが無ければ作成。
3. `新規チャネル作成 → LINEログイン` を選択。
   - チャネル名: 「姿勢チェック」
   - チャネルアイコン・説明文を設定
   - 提供地域: 日本
4. 作成後、`チャネル基本設定` から **チャネル ID** を控える → `LINE_CHANNEL_ID` として GAS スクリプトプロパティに登録。
5. `LIFF` タブで `追加` をクリック。
   - LIFFアプリ名: 「姿勢チェック」
   - サイズ: **Full**
   - エンドポイント URL: 後述のホスティング URL（例: `https://judo-seifukuin.github.io/code/liff/`）
   - Scope: `profile`, `openid` を有効化
   - ボットリンク機能: ON（任意）
6. 発行された **LIFF ID** を控える → `liff/js/config.js` に反映。

---

## 4. LIFF アプリのホスティング

GitHub Pages を使う場合（このリポジトリには `.github/workflows/pages.yml` が含まれている）：

1. リポジトリ `Settings → Pages` で `Source: GitHub Actions` を選択。
2. `main` ブランチに push すると、`liff/` 配下が自動でデプロイされる。
3. デプロイ完了後のページ URL（例: `https://judo-seifukuin.github.io/code/`）をコピーし、末尾 `liff/` を付けたものを LIFF のエンドポイント URL に登録。

外部ホスティング（Netlify / Vercel など）を使う場合も同様に `liff/` ディレクトリを公開すれば良い。

---

## 5. `liff/js/config.js` への設定反映

```js
window.APP_CONFIG = {
  LIFF_ID: "1234567890-XXXXXXXX",                              // 3 で取得した LIFF ID
  GAS_ENDPOINT: "https://script.google.com/macros/s/.../exec", // 2 でデプロイした URL
  DEV_MODE: false,
};
```

変更を main にマージすると GitHub Pages が自動で再デプロイする。

---

## 6. 結線確認（スモークテスト）

1. LINE 公式アカウントを友だち追加した端末で、LIFF の URL（または PC ブラウザで `https://liff.line.me/<LIFF_ID>`）を開く。
2. 同意 → カメラ起動 → 撮影 → スコア表示まで通ること。
3. 「保存する」を押し、スプレッドシートに 1 行追加されることを確認。
4. 「過去履歴を見る」で 1 件以上のレコードが表示されること。
5. （任意）2 回目の解析後に履歴項目をタップし、Before/After 比較ビューに遷移できること。

---

## 7. スタッフ向け管理ビューの利用

スプレッドシートを開くと `姿勢ツール` メニューが表示される（初回起動時は権限承認のダイアログが出るので「許可」を選択）。

- `ユーザー一覧を更新`: 全ユーザーの記録数・初回/最終スコア・変化量を `summary` シートに出力
- `選択ユーザーの推移を表示`: `summary` シートの userId セルを選択した状態で実行するとそのユーザーの推移グラフが `trend` シートに描画される

詳細は `docs/staff-manual.md` 参照。
