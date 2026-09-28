/**
 * 貼り付けデータの読み取り（任意）。
 *
 * 通常はドライブ上の予約表を Source_ が直接読む。予約表以外の来院記録（紙の台帳の転記など）を
 * 足したい場合は、このスプレッドシートに「予約データ」シートを作って1行1予約で貼り付けると、
 * その行も合わせて集計される。1行目 = 見出しとし、設定シートの見出し名で列を特定する。
 */

var Reader_ = (function () {
  function readFromInputSheet(ss, config) {
    const sheet = ss.getSheetByName(SHEET_INPUT);
    if (!sheet) return [];
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
          "「" + SHEET_INPUT + "」シートに見出し「" + label + "」が見つかりません。設定シートの列名を確認してください。" +
          "（見出し: " + headers.filter(String).join(" / ") + "）"
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
      clinic: col(c.clinic, false),
    };
    const pick = function (row, i) { return i >= 0 ? row[i] : ""; };

    const records = [];
    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      if (row.every(function (v) { return v === "" || v === null; })) continue; // 空行
      const clinic = String(pick(row, idx.clinic) || "").trim();
      records.push({
        clinic: config.clinicAliases[clinic] || clinic,
        date: pick(row, idx.date),
        patientId: pick(row, idx.patientId),
        name: pick(row, idx.name),
        staff: pick(row, idx.staff),
        menu: pick(row, idx.menu),
        note: "",
        status: pick(row, idx.status),
      });
    }
    return records;
  }

  return { readFromInputSheet: readFromInputSheet };
})();
