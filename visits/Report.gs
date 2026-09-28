/**
 * 集計の実行と出力シートへの書き込み。
 *
 * 出力シート（毎回全体を書き換える）:
 *   - 抽出リスト: 新患・お久しぶりの来院のみ（新しい順）
 *   - 来院ログ:   全来院に区分を付けたもの（検算・ピボット用）
 *   - 月次集計:   月ごとの件数と推移グラフ
 *   - 担当者別:   月×担当者ごとの件数
 *   - 実行ログ:   実行履歴（追記）
 */

const SHEET_EXTRACT = "抽出リスト";
const SHEET_LOG = "来院ログ";
const SHEET_MONTHLY = "月次集計";
const SHEET_STAFF = "担当者別";
const SHEET_RUNLOG = "実行ログ";

var Report_ = (function () {
  const VISIT_HEADERS = ["来院日", "患者ID", "氏名", "区分", "前回来院日", "空白日数", "担当", "メニュー"];
  const RUNLOG_HEADERS = [
    "実行日時", "実行方法", "読込行数", "来院数", "新患", "新患(要確認)", "お久しぶり",
    "キャンセル除外", "ID空欄除外", "日付不正除外", "データ期間", "結果",
  ];

  function toDate_(ymd) {
    if (!ymd) return "";
    const p = ymd.split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function categoryLabel_(v) {
    return v.category === Classifier_.CATEGORY.NEW && v.needsReview ? "新患（要確認）" : v.category;
  }

  function visitRow_(v) {
    return [
      toDate_(v.date), v.patientId, v.name, categoryLabel_(v),
      toDate_(v.prevDate), v.gapDays === null ? "" : v.gapDays, v.staff, v.menu,
    ];
  }

  function rate_(n, d) {
    return d ? n / d : "";
  }

  // シートを取得（無ければ作成）し、内容を headers + rows で置き換える
  function writeTable_(ss, name, headers, rows, formats) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    sheet.clearContents();
    sheet.getCharts().forEach(function (c) { sheet.removeChart(c); });
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sheet.setFrozenRows(1);
    if (rows.length) {
      const body = sheet.getRange(2, 1, rows.length, headers.length);
      if (formats) body.setNumberFormats(rows.map(function () { return formats; }));
      body.setValues(rows);
    }
    return sheet;
  }

  function writeVisits_(ss, visits) {
    const formats = ["yyyy/MM/dd", "@", "@", "@", "yyyy/MM/dd", "0", "@", "@"];
    // 日付は新しい順、同日内は患者ID順
    const newestFirst = visits.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return a.patientId < b.patientId ? -1 : a.patientId > b.patientId ? 1 : 0;
    });
    const extracted = newestFirst.filter(function (v) { return v.category !== Classifier_.CATEGORY.CONTINUING; });
    writeTable_(ss, SHEET_EXTRACT, VISIT_HEADERS, extracted.map(visitRow_), formats);
    writeTable_(ss, SHEET_LOG, VISIT_HEADERS, newestFirst.map(visitRow_), formats);
    return extracted.length;
  }

  function writeMonthly_(ss, summary) {
    const headers = ["月", "延べ来院数", "実患者数", "新患", "新患(要確認)", "お久しぶり", "継続", "新患率", "お久しぶり率"];
    const rows = summary.months.map(function (m) {
      return [
        m.month, m.total, m.patients, m.newConfirmed, m.newReview, m.returning, m.continuing,
        rate_(m.newConfirmed + m.newReview, m.patients), rate_(m.returning, m.patients),
      ];
    });
    const sheet = writeTable_(ss, SHEET_MONTHLY, headers, rows, ["@", "0", "0", "0", "0", "0", "0", "0.0%", "0.0%"]);

    if (rows.length) {
      const n = rows.length + 1;
      const chart = sheet.newChart()
        .setChartType(Charts.ChartType.COLUMN)
        .addRange(sheet.getRange(1, 1, n, 1)) // 月
        .addRange(sheet.getRange(1, 4, n, 3)) // 新患 / 新患(要確認) / お久しぶり
        .setPosition(2, headers.length + 2, 0, 0)
        .setOption("title", "新患・お久しぶり患者数の推移")
        .setOption("isStacked", true)
        .setOption("legend", { position: "bottom" })
        .build();
      sheet.insertChart(chart);
    }

    const staffHeaders = ["月", "担当", "延べ来院数", "新患", "新患(要確認)", "お久しぶり"];
    const staffRows = summary.staff.map(function (s) {
      return [s.month, s.staff, s.total, s.newConfirmed, s.newReview, s.returning];
    });
    writeTable_(ss, SHEET_STAFF, staffHeaders, staffRows, ["@", "@", "0", "0", "0", "0"]);
  }

  function appendRunLog_(ss, row) {
    let sheet = ss.getSheetByName(SHEET_RUNLOG);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_RUNLOG);
      sheet.getRange(1, 1, 1, RUNLOG_HEADERS.length).setValues([RUNLOG_HEADERS]).setFontWeight("bold");
      sheet.setFrozenRows(1);
    }
    while (row.length < RUNLOG_HEADERS.length) row.push("");
    sheet.appendRow(row);
  }

  /**
   * 集計を実行する。
   * @param {Spreadsheet} ss
   * @param {string} trigger "手動" | "自動"
   * @return {{ok: boolean, message: string}}
   */
  function run(ss, trigger) {
    const lock = LockService.getDocumentLock();
    if (!lock.tryLock(30 * 1000)) {
      return { ok: false, message: "別の集計が実行中です。しばらくしてから再実行してください。" };
    }
    try {
      const config = Config_.load(ss);
      const records = Reader_.readFromInputSheet(ss, config);
      const result = Classifier_.classify(records, { thresholdDays: config.thresholdDays, cancelWords: config.cancelWords });
      const extractedCount = writeVisits_(ss, result.visits);
      writeMonthly_(ss, Classifier_.summarizeMonthly(result.visits));

      const count = function (pred) { return result.visits.filter(pred).length; };
      const newConfirmed = count(function (v) { return v.category === Classifier_.CATEGORY.NEW && !v.needsReview; });
      const newReview = count(function (v) { return v.category === Classifier_.CATEGORY.NEW && v.needsReview; });
      const returning = count(function (v) { return v.category === Classifier_.CATEGORY.RETURNING; });
      const period = result.dataStart ? result.dataStart + " 〜 " + result.dataEnd : "";

      appendRunLog_(ss, [
        new Date(), trigger, records.length, result.visits.length, newConfirmed, newReview, returning,
        result.excluded.cancelled, result.excluded.noPatientId, result.excluded.invalidDate, period, "OK",
      ]);

      const lines = [
        "集計が完了しました（" + period + "）。",
        "来院 " + result.visits.length + " 件 / 抽出 " + extractedCount + " 件",
        "  新患: " + newConfirmed + " 件（ほか要確認 " + newReview + " 件）",
        "  お久しぶり（" + config.thresholdDays + "日以上）: " + returning + " 件",
      ];
      const ex = result.excluded;
      if (ex.cancelled || ex.noPatientId || ex.invalidDate) {
        lines.push("除外: キャンセル " + ex.cancelled + " / ID空欄 " + ex.noPatientId + " / 日付不正 " + ex.invalidDate);
      }
      return { ok: true, message: lines.join("\n") };
    } catch (err) {
      appendRunLog_(ss, [new Date(), trigger, "", "", "", "", "", "", "", "", "", "エラー: " + (err.message || err)]);
      return { ok: false, message: String(err.message || err) };
    } finally {
      lock.releaseLock();
    }
  }

  return { run: run };
})();
