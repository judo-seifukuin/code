// LIFF / GAS 接続設定
// LINE Developers と GAS Web App のデプロイ完了後に実際の値へ置き換える。
window.APP_CONFIG = {
  // LINE Developers > LIFF で発行される LIFF ID
  LIFF_ID: "YOUR_LIFF_ID",

  // Apps Script > デプロイ > 新しいデプロイ > ウェブアプリ で発行されるエンドポイントURL
  GAS_ENDPOINT: "https://script.google.com/macros/s/XXXXXXXXXXXX/exec",

  // 開発用フラグ。true の場合は LIFF 初期化を行わずダミーIDで動作する。
  DEV_MODE: false,
};
