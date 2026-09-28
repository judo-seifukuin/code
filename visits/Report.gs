/**
 * 集計の実行と出力シートへの書き込み。
 *
 * 出力シート（毎回全体を書き換える）:
 *   - 抽出リスト: 新患・お久しぶりの来院のみ（新しい順）
 *   - 来院ログ:   全来院に区分を付けたもの（検算・ピボット用）
 *   - 月次集計:   院×月ごとの件数と推移グラフ（院が複数なら「全院」行あり）
 *   - 担当者別:   院×月×担当者ごとの件数
 *   - 実行ログ:   実行履歴（追記）
 */

const SHEET_EXTRACT = "抽出リスト";
const SHEET_LOG = "来院ログ";
const SHEET_MONTHLY = "月次集計";
const SHEET_STAFF = "担当者別";
const SHEET_RUNLOG = "実行ログ";

var Report_ = (function () {
  const VISIT_HEADERS = ["院", "来院日", "患者ID", "氏名", "区分", "前回来院日", "空白日数", "担当", "備考"];
  const RUNLOG_HEADERS = [
    "実行日時", "実行方法", "対象ファイル", "読込ファイル", "予約枠数", "来院数",
    "新患", "新患(要確認)", "新患(番号未発行)", "お久しぶり",
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
      v.clinic, toDate_(v.date), v.patientId, v.name, categoryLabel_(v),
      toDate_(v.prevDate), v.gapDays === null ? "" : v.gapDays, v.staff,
      [v.note, v.menu].filter(String).join(" / "),
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
    const formats = ["@", "yyyy/MM/dd", "@", "@", "@", "yyyy/MM/dd", "0", "@", "@"];
    // 日付は新しい順、同日内は院・患者ID順
    const newestFirst = visits.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.clinic !== b.clinic) return a.clinic < b.clinic ? -1 : 1;
      return a.patientId < b.patientId ? -1 : a.patientId > b.patientId ? 1 : 0;
    });
    const extracted = newestFirst.filter(function (v) { return v.category !== Classifier_.CATEGORY.CONTINUING; });
    writeTable_(ss, SHEET_EXTRACT, VISIT_HEADERS, extracted.map(visitRow_), formats);
    writeTable_(ss, SHEET_LOG, VISIT_HEADERS, newestFirst.map(visitRow_), formats);
    return extracted.length;
  }

  function writeMonthly_(ss, summary) {
    const headers = [
      "院", "月", "延べ来院数", "実患者数", "新患", "新患(要確認)", "新患(番号未発行)", "お久しぶり", "継続", "新患率", "お久しぶり率",
    ];
    const rows = summary.months.map(function (m) {
      return [
        m.clinic, m.month, m.total, m.patients, m.newConfirmed, m.newReview, m.newUnregistered, m.returning, m.continuing,
        rate_(m.newConfirmed + m.newReview + m.newUnregistered, m.patients), rate_(m.returning, m.patients),
      ];
    });
    const sheet = writeTable_(ss, SHEET_MONTHLY, headers, rows, ["@", "@", "0", "0", "0", "0", "0", "0", "0", "0.0%", "0.0%"]);

    if (rows.length) {
      // 先頭の院（院が複数なら「全院」）の行だけでグラフを作る
      const first = rows[0][0];
      let n = 0;
      while (n < rows.length && rows[n][0] === first) n++;
      const chart = sheet.newChart()
        .setChartType(Charts.ChartType.COLUMN)
        .addRange(sheet.getRange(1, 2, n + 1, 1)) // 月
        .addRange(sheet.getRange(1, 5, n + 1, 4)) // 新患 / 要確認 / 番号未発行 / お久しぶり
        .setPosition(2, headers.length + 2, 0, 0)
        .setOption("title", "新患・お久しぶり患者数の推移（" + (first || "全体") + "）")
        .setOption("isStacked", true)
        .setOption("legend", { position: "bottom" })
        .build();
      sheet.insertChart(chart);
    }

    const staffHeaders = ["院", "月", "担当", "延べ来院数", "新患", "新患(要確認)", "新患(番号未発行)", "お久しぶり"];
    const staffRows = summary.staff.map(function (s) {
      return [s.clinic, s.month, s.staff, s.total, s.newConfirmed, s.newReview, s.newUnregistered, s.returning];
    });
    writeTable_(ss, SHEET_STAFF, staffHeaders, staffRows, ["@", "@", "@", "0", "0", "0", "0", "0"]);
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
   * 集計を実行する（排他制御は呼び出し側 Menu.gs で行う）。
   * @param {Spreadsheet} ss
   * @param {string} trigger "手動" | "手動（全読込）" | "自動"
   * @param {{full?: boolean}=} opts full: 全ファイルを読み直す
   * @return {{ok: boolean, message: string}}
   */
  function run(ss, trigger, opts) {
    try {
      const config = Config_.load(ss);
      let source = { records: [], files: 0, filesRead: 0, pending: 0 };
      const pasted = Reader_.readFromInputSheet(ss, config);
      if (Source_.hasFileList(ss) || !pasted.length) source = Source_.loadRecords(ss, config, opts);
      const records = source.records.concat(pasted);

      const result = Classifier_.classify(records, {
        thresholdDays: config.thresholdDays,
        cancelWords: config.cancelWords,
        tempIds: config.tempIds,
        sharedIds: config.sharedIds,
      });
      const extractedCount = writeVisits_(ss, result.visits);
      writeMonthly_(ss, Classifier_.summarizeMonthly(result.visits));

      const C = Classifier_.CATEGORY;
      const count = function (pred) { return result.visits.filter(pred).length; };
      const newConfirmed = count(function (v) { return v.category === C.NEW && !v.needsReview; });
      const newReview = count(function (v) { return v.category === C.NEW && v.needsReview; });
      const newUnregistered = count(function (v) { return v.category === C.UNREGISTERED; });
      const returning = count(function (v) { return v.category === C.RETURNING; });
      const period = result.dataStart ? result.dataStart + " 〜 " + result.dataEnd : "";
      const ex = result.excluded;

      appendRunLog_(ss, [
        new Date(), trigger, source.files, source.filesRead, records.length, result.visits.length,
        newConfirmed, newReview, newUnregistered, returning,
        ex.cancelled, ex.noPatientId, ex.invalidDate, period,
        source.pending ? "一部のみ（未読込 " + source.pending + " ファイル）" : "OK",
      ]);

      const lines = [
        "集計が完了しました（" + period + "）。",
        "予約表 " + source.files + " ファイル（今回読込 " + source.filesRead + "）",
        "来院 " + result.visits.length + " 件 / 抽出 " + extractedCount + " 件",
        "  新患: " + newConfirmed + " 件（ほか要確認 " + newReview + " 件、番号未発行 " + newUnregistered + " 件）",
        "  お久しぶり（" + config.thresholdDays + "日以上）: " + returning + " 件",
      ];
      if (ex.cancelled || ex.noPatientId || ex.invalidDate) {
        lines.push("除外: キャンセル " + ex.cancelled + " / 番号なし " + ex.noPatientId + " / 日付不正 " + ex.invalidDate);
      }
      if (source.pending) {
        lines.push("", "※ 時間内に読み切れなかったファイルが " + source.pending + " 件あります。もう一度「今すぐ集計」を実行してください。");
      }
      return { ok: true, message: lines.join("\n"), pending: source.pending };
    } catch (err) {
      appendRunLog_(ss, [new Date(), trigger, "", "", "", "", "", "", "", "", "", "", "", "", "エラー: " + (err.message || err)]);
      return { ok: false, message: String(err.message || err) };
    }
  }

  return { run: run };
})();
