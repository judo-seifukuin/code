# GAS デプロイ クイックスタート

`docs/setup.md` の GAS パートを **実値入り** にまとめたものです。Google Apps Script の Web App をデプロイし、LIFF と接続するまで通します。

> ⚠️ PC（Mac/Windows）で作業してください。Apps Script のエディタは iPhone では実用的に動きません。

---

## 0. 必要な値（既に揃っています）

| キー | 値 | 用途 |
| --- | --- | --- |
| `LINE_CHANNEL_ID` | `2009687396` | LINE IDトークン検証 |
| `SHEET_ID` | `1mFJtcESFy_QetunAwhNt9UYnyjNTBFl_4-eKUNhDcO8` | 保存先スプレッドシート |
| `DRIVE_FOLDER_ID` | `1wAS3duBJm6lQix85CNuFmLC-X3MIlw6y` | 骨格画像保存先 |

スプレッドシート: https://docs.google.com/spreadsheets/d/1mFJtcESFy_QetunAwhNt9UYnyjNTBFl_4-eKUNhDcO8/edit
画像保存フォルダ: https://drive.google.com/drive/folders/1wAS3duBJm6lQix85CNuFmLC-X3MIlw6y

---

## 1. Apps Script プロジェクトを開く

1. 上の **スプレッドシート URL** を PC ブラウザで開く
2. メニュー `拡張機能 → Apps Script` をクリック
3. 別タブで Apps Script エディタが開く（初回はプロジェクト名「無題のプロジェクト」）
4. 左上のプロジェクト名をクリックして `AI Pose Analyzer` に変更

---

## 2. マニフェストファイル `appsscript.json` を表示する

1. 左メニュー（歯車アイコン）`プロジェクトの設定` を開く
2. `「appsscript.json」マニフェストファイルをエディタで表示する` にチェック ✓
3. 左サイドの「エディタ」アイコンに戻る → `appsscript.json` がファイル一覧に出る

---

## 3. ファイルを4つ作って中身を貼り付ける

リポジトリ https://github.com/judo-seifukuin/code/tree/main/gas の以下4ファイルをそれぞれコピペする：

### 3-1. `appsscript.json`（既存ファイルを上書き）

[gas/appsscript.json](https://github.com/judo-seifukuin/code/blob/main/gas/appsscript.json) の内容を全選択コピー → Apps Script の `appsscript.json` を全消しして貼り付け → 保存（Ctrl/Cmd+S）

### 3-2. `Code.gs`（既存ファイルを上書き）

[gas/Code.gs](https://github.com/judo-seifukuin/code/blob/main/gas/Code.gs) の内容を Apps Script の `Code.gs` に貼り付けて保存。

### 3-3. `Auth.gs`（新規作成）

エディタ上部の `+` → `スクリプト` → 名前 `Auth` で作成。
[gas/Auth.gs](https://github.com/judo-seifukuin/code/blob/main/gas/Auth.gs) を貼り付けて保存。

### 3-4. `Store.gs`（新規作成）

同様に `+` → `スクリプト` → 名前 `Store` で作成。
[gas/Store.gs](https://github.com/judo-seifukuin/code/blob/main/gas/Store.gs) を貼り付けて保存。

### 3-5. `Admin.gs`（新規作成）

同様に `+` → `スクリプト` → 名前 `Admin` で作成。
[gas/Admin.gs](https://github.com/judo-seifukuin/code/blob/main/gas/Admin.gs) を貼り付けて保存。

> 💡 ファイル名に `.gs` は付けない。Apps Script が自動で付ける。

---

## 4. スクリプトプロパティを登録する

1. 左メニュー（歯車）`プロジェクトの設定`
2. ページ下部の `スクリプト プロパティ` セクション
3. 「プロパティを追加」を3回押して、以下を登録：

```
LINE_CHANNEL_ID = 2009687396
SHEET_ID        = 1mFJtcESFy_QetunAwhNt9UYnyjNTBFl_4-eKUNhDcO8
DRIVE_FOLDER_ID = 1wAS3duBJm6lQix85CNuFmLC-X3MIlw6y
```

「スクリプトプロパティを保存」をクリック。

---

## 5. Web App としてデプロイ

1. 右上 `デプロイ → 新しいデプロイ`
2. 左上の歯車 → `ウェブアプリ` を選択
3. 設定：
   - **説明**: `AI Pose Analyzer v1`
   - **次のユーザーとして実行**: `自分（minakisctno1@gmail.com）`
   - **アクセスできるユーザー**: **`全員`** ← ⚠️ ここを「全員」にしないと LIFF から呼べない
4. `デプロイ` をクリック
5. 初回は **権限承認のダイアログ** が出る：
   - 「アクセスを承認」
   - Google アカウントを選択
   - 「詳細を表示」→「（プロジェクト名）に移動（安全ではないページ）」※開発中なので警告が出るが OK
   - 「許可」
6. デプロイ完了画面に **`ウェブアプリの URL`** が出る（`https://script.google.com/macros/s/.....exec` の形式）
7. **そのURLをコピーしてここに貼ってください** → 私が `liff/js/config.js` の `GAS_ENDPOINT` に反映する PR を作ります

---

## 6. 動作確認（オプション）

デプロイ URL をそのままブラウザで開き、以下のような JSON が返れば OK：

```json
{"ok":true,"service":"AI Pose Analyzer","version":"0.1.0"}
```

返らない場合は権限承認の途中で詰まっている可能性大。手順5の権限承認をもう一度。

---

## 7. スタッフ向け管理ビューが使えるか確認

スプレッドシートを開き直すと、画面上部に **「姿勢ツール」** メニューが追加されている。
（初回起動時は権限承認ダイアログが出るので「許可」）

- `姿勢ツール → ユーザー一覧を更新`
- `姿勢ツール → 選択ユーザーの推移を表示`

---

## トラブル時のチェックリスト

| 症状 | 対処 |
| --- | --- |
| デプロイ URL が 404 / 403 | 「アクセスできるユーザー」が **全員** になっていない |
| `IDトークン検証失敗` | `LINE_CHANNEL_ID` の値が誤り（`2009687396`） |
| `SHEET_ID script property is not set` | スクリプトプロパティ未登録 |
| 「姿勢ツール」メニューが出ない | `Admin.gs` を作成していない / スプレッドシートをリロード |
