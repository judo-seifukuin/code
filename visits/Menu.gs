/**
 * スプレッドシートのカスタムメニューと毎日自動実行トリガー。
 *
 * 起動: スプレッドシートを開くと onOpen が動き、「来院分析」メニューが追加される。
 */

const DAILY_HANDLER = "Visits_runDaily";
const DAILY_HOUR = 5; // 毎朝 5 時台（Asia/Tokyo）

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("来院分析")
    .addItem("今すぐ集計", "Visits_runNow")
    .addSeparator()
    .addItem("初期設定（シート作成）", "Visits_setup")
    .addItem("毎日自動実行をON", "Visits_enableDaily")
    .addItem("毎日自動実行をOFF", "Visits_disableDaily")
    .addToUi();
}

function Visits_setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Config_.ensureSheet(ss);
  const input = Reader_.ensureInputSheet(ss, Config_.load(ss));
  ss.setActiveSheet(input);
  SpreadsheetApp.getUi().alert(
    "「" + SHEET_INPUT + "」と「" + SHEET_CONFIG + "」シートを用意しました。\n\n" +
    "1. 予約表から見出し行ごとコピーして「" + SHEET_INPUT + "」に貼り付けてください。\n" +
    "2. 見出し名が違う場合は「" + SHEET_CONFIG + "」の B 列を予約表の見出しに合わせてください。\n" +
    "3. メニュー「来院分析 → 今すぐ集計」で結果が作成されます。"
  );
}

function Visits_runNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = Report_.run(ss, "手動");
  if (result.ok) {
    const sheet = ss.getSheetByName(SHEET_EXTRACT);
    if (sheet) ss.setActiveSheet(sheet);
  }
  SpreadsheetApp.getUi().alert(result.ok ? result.message : "集計できませんでした。\n\n" + result.message);
}

// 時間主導トリガーから呼ばれる（UI は使えない）
function Visits_runDaily() {
  const result = Report_.run(SpreadsheetApp.getActiveSpreadsheet(), "自動");
  if (!result.ok) console.error(result.message);
}

function Visits_enableDaily() {
  deleteDailyTriggers_();
  ScriptApp.newTrigger(DAILY_HANDLER).timeBased().everyDays(1).atHour(DAILY_HOUR).create();
  SpreadsheetApp.getUi().alert("毎日 " + DAILY_HOUR + " 時台に自動で集計するよう設定しました。");
}

function Visits_disableDaily() {
  const n = deleteDailyTriggers_();
  SpreadsheetApp.getUi().alert(n ? "毎日自動実行を停止しました。" : "毎日自動実行は設定されていません。");
}

function deleteDailyTriggers_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === DAILY_HANDLER) {
      ScriptApp.deleteTrigger(t);
      n++;
    }
  });
  return n;
}
