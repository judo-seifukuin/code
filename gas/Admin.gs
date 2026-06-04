/**
 * スタッフ向け管理ビュー（スプレッドシートのカスタムメニュー）。
 *
 * 計画書 §4.2: 「蓄積されたデータ群から、必要な患者の推移を一覧で確認できる管理ビュー」
 *
 * 提供機能:
 *   - 「ユーザー一覧を更新」: ユーザーIDごとに記録数・最終スコア・初回スコア・変化量を集計
 *   - 「推移グラフを生成」: 選択中ユーザーのスコア推移を別シートにグラフ表示
 *
 * 起動: スプレッドシートを開いたとき onOpen が動き、「姿勢ツール」メニューが追加される。
 */

const SUMMARY_SHEET = "summary";
const TREND_SHEET = "trend";

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("姿勢ツール")
    .addItem("ユーザー一覧を更新", "Admin_refreshSummary")
    .addItem("選択ユーザーの推移を表示", "Admin_showTrend")
    .addToUi();
}

function Admin_refreshSummary() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const records = ss.getSheetByName("records");
  if (!records || records.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert("records シートにデータがありません。");
    return;
  }

  const values = records.getRange(2, 1, records.getLastRow() - 1, 7).getValues();
  const byUser = {};
  values.forEach((r) => {
    const userId = r[2];
    const at = r[0];
    const score = Number(r[3]) || 0;
    if (!byUser[userId]) {
      byUser[userId] = { count: 0, first: null, last: null, max: -Infinity, min: Infinity };
    }
    const u = byUser[userId];
    u.count += 1;
    if (!u.first || at < u.first.at) u.first = { at, score };
    if (!u.last || at > u.last.at) u.last = { at, score };
    if (score > u.max) u.max = score;
    if (score < u.min) u.min = score;
  });

  let sheet = ss.getSheetByName(SUMMARY_SHEET);
  if (!sheet) sheet = ss.insertSheet(SUMMARY_SHEET);
  sheet.clear();
  const headers = ["userId", "記録数", "初回日", "初回スコア", "最終日", "最終スコア", "変化量", "最大", "最小"];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);

  const rows = Object.keys(byUser).map((userId) => {
    const u = byUser[userId];
    const diff = u.last.score - u.first.score;
    return [
      userId,
      u.count,
      u.first.at,
      u.first.score,
      u.last.at,
      u.last.score,
      diff,
      u.max,
      u.min,
    ];
  });
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    sheet.getRange(2, 3).getDataRegion().setNumberFormats(
      rows.map(() => ["@", "0", "yyyy/MM/dd HH:mm", "0", "yyyy/MM/dd HH:mm", "0", "+0;-0;0", "0", "0"])
    );
  }
  sheet.autoResizeColumns(1, headers.length);
  SpreadsheetApp.getUi().alert(`ユーザー ${rows.length} 名のサマリを更新しました。`);
}

function Admin_showTrend() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const active = ss.getActiveSheet();
  const cell = active.getActiveCell();
  let userId = "";
  if (active.getName() === SUMMARY_SHEET && cell.getColumn() === 1) {
    userId = cell.getValue();
  }
  if (!userId) {
    const resp = SpreadsheetApp.getUi().prompt("対象の userId を入力してください。", SpreadsheetApp.getUi().ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== SpreadsheetApp.getUi().Button.OK) return;
    userId = resp.getResponseText().trim();
  }
  if (!userId) return;

  const records = ss.getSheetByName("records");
  const values = records.getRange(2, 1, records.getLastRow() - 1, 7).getValues();
  const trend = values
    .filter((r) => r[2] === userId)
    .map((r) => [r[0], Number(r[3]) || 0])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (!trend.length) {
    SpreadsheetApp.getUi().alert("該当データがありません。");
    return;
  }

  let sheet = ss.getSheetByName(TREND_SHEET);
  if (!sheet) sheet = ss.insertSheet(TREND_SHEET);
  sheet.clear();
  sheet.getCharts().forEach((c) => sheet.removeChart(c));

  sheet.getRange(1, 1, 1, 2).setValues([["日時", `${userId} のスコア`]]);
  sheet.getRange(2, 1, trend.length, 2).setValues(trend);

  const chart = sheet.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(sheet.getRange(1, 1, trend.length + 1, 2))
    .setPosition(2, 4, 0, 0)
    .setOption("title", `${userId} のスコア推移`)
    .setOption("legend", { position: "none" })
    .setOption("vAxis", { minValue: 0, maxValue: 100 })
    .build();
  sheet.insertChart(chart);

  ss.setActiveSheet(sheet);
}
