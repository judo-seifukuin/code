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
    .addItem("今すぐ集計（更新分のみ読込）", "Visits_runNow")
    .addItem("全ファイルを読み直して集計", "Visits_runFull")
    .addItem("予約表ファイルを検索", "Visits_discover")
    .addSeparator()
    .addItem("初期設定", "Visits_setup")
    .addItem("毎日自動実行をON", "Visits_enableDaily")
    .addItem("毎日自動実行をOFF", "Visits_disableDaily")
    .addToUi();
}

// 集計・検索が同時に走らないよう、入口で1回だけロックを取る
function withLock_(fn) {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30 * 1000)) {
    return { ok: false, message: "別の処理が実行中です。しばらくしてから再実行してください。" };
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function discoverMessage_(r) {
  return "予約表 " + (r.total - r.excluded) + " ファイル（院: " + (r.clinics.join("・") || "なし") + "）、" +
    "うち対象 " + r.targets + " ファイル。対象外（原本・使用禁止など）" + r.excluded + " ファイル。";
}

function Visits_setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const res = withLock_(function () {
    Config_.ensureSheet(ss);
    return { ok: true, message: discoverMessage_(Source_.discoverFiles(ss, Config_.load(ss))) };
  });
  const files = ss.getSheetByName(SHEET_FILES);
  if (files) ss.setActiveSheet(files);
  SpreadsheetApp.getUi().alert(res.ok
    ? res.message + "\n\n" +
      "1.「" + SHEET_FILES + "」で集計に使うファイルにチェックが入っているか確認してください。\n" +
      "2.「" + SHEET_CONFIG + "」でお久しぶりの日数・仮番号などを確認してください。\n" +
      "3. メニュー「来院分析 → 今すぐ集計」で結果が作成されます（初回は数分かかります）。"
    : res.message);
}

function Visits_discover() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const res = withLock_(function () {
    return { ok: true, message: discoverMessage_(Source_.discoverFiles(ss, Config_.load(ss))) };
  });
  const files = ss.getSheetByName(SHEET_FILES);
  if (files) ss.setActiveSheet(files);
  SpreadsheetApp.getUi().alert(res.message);
}

function runWithUi_(trigger, opts) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = withLock_(function () { return Report_.run(ss, trigger, opts); });
  if (result.ok) {
    const sheet = ss.getSheetByName(SHEET_EXTRACT);
    if (sheet) ss.setActiveSheet(sheet);
  }
  SpreadsheetApp.getUi().alert(result.ok ? result.message : "集計できませんでした。\n\n" + result.message);
}

function Visits_runNow() {
  runWithUi_("手動", { full: false });
}

function Visits_runFull() {
  runWithUi_("手動（全読込）", { full: true });
}

// 時間主導トリガーから呼ばれる（UI は使えない）。新しい月のファイルも拾うため先に検索する
function Visits_runDaily() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = withLock_(function () {
    Source_.discoverFiles(ss, Config_.load(ss));
    return Report_.run(ss, "自動", { full: false });
  });
  if (!result.ok) console.error(result.message);
}

function Visits_enableDaily() {
  deleteDailyTriggers_();
  ScriptApp.newTrigger(DAILY_HANDLER).timeBased().everyDays(1).atHour(DAILY_HOUR).create();
  SpreadsheetApp.getUi().alert("毎日 " + DAILY_HOUR + " 時台に、予約表の検索と集計を自動で行うよう設定しました。");
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
