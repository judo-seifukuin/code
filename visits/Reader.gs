/**
 * 予約データの読み取り（接続なし版）。
 *
 * このスプレッドシート内の「予約データ」タブに、予約表から見出し行ごと貼り付けた内容を読む。
 * 1行目 = 見出し、2行目以降 = 1行1予約 を前提とし、設定シートの見出し名で列を特定する。
 *
 * 将来、予約表スプレッドシートへ直接接続する場合は、同じ形の配列
 *   [{ date, patientId, name, staff, menu, status }]
 * を返す関数を別途用意し、Report_.run に渡すだけでよい。
 */

var Reader_ = (function () {
  function ensureInputSheet(ss, config) {
    let sheet = ss.getSheetByName(SHEET_INPUT);
    if (sheet) return sheet;
    sheet = ss.insertSheet(SHEET_INPUT, 0);
    const c = config.columns;
    const headers = [c.date, c.patientId, c.name, c.staff, c.menu, c.status].filter(String);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sheet.setFrozenRows(1);
    return sheet;
  }

  function readFromInputSheet(ss, config) {
    const sheet = ss.getSheetByName(SHEET_INPUT);
    if (!sheet) throw new Error("「" + SHEET_INPUT + "」シートがありません。メニューの「初期設定」を実行してください。");
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) return [];

    const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    const headers = values[0].map(function (h) { return String(h).trim(); });
    const col = function (label, required) {
      if (!label) return -1;
      const idx = headers.indexOf(label);
      if (idx === -1 && required) {
        throw new Error(
          "予約データに見出し「" + label + "」が見つかりません。設定シートの列名を確認してください。" +
          "（予約データの見出し: " + headers.filter(String).join(" / ") + "）"
        );
      }
      return idx;
    };
    const c = config.columns;
    const idx = {
      date: col(c.date, true),
      patientId: col(c.patientId, true),
      name: col(c.name, false),
      staff: col(c.staff, false),
      menu: col(c.menu, false),
      status: col(c.status, false),
    };
    const pick = function (row, i) { return i >= 0 ? row[i] : ""; };

    const records = [];
    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      if (row.every(function (v) { return v === "" || v === null; })) continue; // 空行
      records.push({
        date: pick(row, idx.date),
        patientId: pick(row, idx.patientId),
        name: pick(row, idx.name),
        staff: pick(row, idx.staff),
        menu: pick(row, idx.menu),
        status: pick(row, idx.status),
      });
    }
    return records;
  }

  return { ensureInputSheet: ensureInputSheet, readFromInputSheet: readFromInputSheet };
})();
