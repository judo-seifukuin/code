/**
 * ドライブ上の予約表（名前に "/Res/" を含むスプレッドシート）の検索と読み込み。
 *
 * 予約表は読むだけで、書き換えは一切しない。
 *
 *   - ファイル一覧: 見つかった予約表と「対象」チェック・最終読込日時を管理する
 *   - 予約明細:     読み込んだ予約を1枠1行で保存したもの。次回は更新されたファイルだけ読み直す
 *
 * 日タブの取得は Sheets API（高度なサービス）の batchGet で1ファイルあたり数回にまとめる。
 * SpreadsheetApp で1タブずつ開くと、院数×月数×30タブで6分の実行時間制限を超えるため。
 */

const SHEET_FILES = "ファイル一覧";
const SHEET_DETAIL = "予約明細";

var Source_ = (function () {
  const QUERY = 'title contains "/Res/" and mimeType = "application/vnd.google-apps.spreadsheet" and trashed = false';
  const FILE_HEADERS = ["対象", "院", "年", "月", "ファイル名", "ファイルID", "最終更新", "最終読込", "メモ"];
  const DETAIL_HEADERS = ["院", "日付", "時刻", "担当", "NO", "名前", "備考", "ファイルID"];
  const COL = { checked: 0, clinic: 1, year: 2, months: 3, title: 4, id: 5, updated: 6, lastRead: 7, memo: 8 };
  const RANGE = "!A1:AZ100";
  const RANGES_PER_CALL = 30;
  const TIME_BUDGET_MS = 4 * 60 * 1000; // 残りは判定と書き込みに回す（GAS の上限は6分）

  function toTime_(v) {
    if (!v) return 0;
    const t = Object.prototype.toString.call(v) === "[object Date]" ? v.getTime() : new Date(v).getTime();
    return isNaN(t) ? 0 : t;
  }

  function readFileList_(ss) {
    const sheet = ss.getSheetByName(SHEET_FILES);
    if (!sheet || sheet.getLastRow() < 2) return null;
    return sheet.getRange(2, 1, sheet.getLastRow() - 1, FILE_HEADERS.length).getValues()
      .filter(function (r) { return String(r[COL.id]).trim(); })
      .map(function (r) {
        return {
          checked: r[COL.checked] === true,
          clinic: r[COL.clinic],
          year: r[COL.year],
          months: r[COL.months],
          title: String(r[COL.title]),
          id: String(r[COL.id]).trim(),
          updated: r[COL.updated],
          lastRead: r[COL.lastRead],
          memo: r[COL.memo],
        };
      });
  }

  function writeFileList_(ss, files) {
    let sheet = ss.getSheetByName(SHEET_FILES);
    if (!sheet) sheet = ss.insertSheet(SHEET_FILES);
    sheet.clearContents();
    if (sheet.getMaxRows() > 1) sheet.getRange(2, 1, sheet.getMaxRows() - 1, 1).clearDataValidations();
    sheet.getRange(1, 1, 1, FILE_HEADERS.length).setValues([FILE_HEADERS]).setFontWeight("bold");
    sheet.setFrozenRows(1);
    if (!files.length) return sheet;
    const rows = files.map(function (f) {
      return [f.checked, f.clinic, f.year, f.months, f.title, f.id, f.updated || "", f.lastRead || "", f.memo || ""];
    });
    const body = sheet.getRange(2, 1, rows.length, FILE_HEADERS.length);
    body.setNumberFormats(rows.map(function () { return ["@", "@", "0", "@", "@", "@", "yyyy/MM/dd HH:mm", "yyyy/MM/dd HH:mm", "@"]; }));
    sheet.getRange(2, 1, rows.length, 1).insertCheckboxes(); // 値は false になるので先に入れてから setValues
    body.setValues(rows);
    return sheet;
  }

  /**
   * ドライブを検索してファイル一覧を作り直す。チェック状態と最終読込は ファイルID で引き継ぐ。
   * 新しく見つかった予約表は対象（チェックあり）、原本・使用禁止などは対象外で一覧の下に並べる。
   */
  function discoverFiles(ss, config) {
    const prev = {};
    (readFileList_(ss) || []).forEach(function (f) { prev[f.id] = f; });

    const found = [];
    const it = DriveApp.searchFiles(QUERY);
    while (it.hasNext()) {
      const file = it.next();
      found.push({ id: file.getId(), title: file.getName(), updated: file.getLastUpdated() });
    }

    // 同じ院・同じ月を含むファイルが複数ある場合はメモで知らせる（どちらも読み、同日同番号は1来院にまとまる）
    const monthCount = {};
    found.forEach(function (f) {
      f.info = GridReader_.parseTitle(f.title, config.clinicAliases);
      if (!f.info.ok) return;
      f.info.months.forEach(function (m) {
        const k = f.info.clinic + "|" + f.info.year + "|" + m;
        monthCount[k] = (monthCount[k] || 0) + 1;
      });
    });

    const files = found.map(function (f) {
      const p = prev[f.id];
      if (!f.info.ok) {
        return { ok: false, checked: false, clinic: "", year: "", months: "", title: f.title, id: f.id, updated: f.updated, lastRead: "", memo: "対象外: " + f.info.reason };
      }
      const dup = f.info.months.some(function (m) { return monthCount[f.info.clinic + "|" + f.info.year + "|" + m] > 1; });
      return {
        ok: true,
        checked: p ? p.checked : true,
        clinic: f.info.clinic,
        year: f.info.year,
        months: f.info.months.join(","),
        firstMonth: f.info.months[0],
        title: f.title,
        id: f.id,
        updated: f.updated,
        lastRead: p ? p.lastRead : "",
        memo: dup ? "同じ院・月のファイルが他にもあります（不要なら対象を外してください）" : "",
      };
    });

    files.sort(function (a, b) {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      if (a.clinic !== b.clinic) return a.clinic < b.clinic ? -1 : 1;
      if (a.year !== b.year) return a.year - b.year;
      if (a.firstMonth !== b.firstMonth) return a.firstMonth - b.firstMonth;
      return a.title < b.title ? -1 : 1;
    });
    writeFileList_(ss, files);

    const ok = files.filter(function (f) { return f.ok; });
    return {
      total: files.length,
      targets: ok.filter(function (f) { return f.checked; }).length,
      excluded: files.length - ok.length,
      clinics: Object.keys(ok.reduce(function (m, f) { m[f.clinic] = true; return m; }, {})),
    };
  }

  // 1ファイル分の日タブをすべて読み、予約レコードにする
  function fetchFile_(fileId, info) {
    const meta = Sheets.Spreadsheets.get(fileId, { fields: "sheets.properties.title" });
    const names = (meta.sheets || [])
      .map(function (s) { return s.properties.title; })
      .filter(function (n) { return GridReader_.sheetDate(n, info); });
    const records = [];
    for (let i = 0; i < names.length; i += RANGES_PER_CALL) {
      const chunk = names.slice(i, i + RANGES_PER_CALL);
      const resp = Sheets.Spreadsheets.Values.batchGet(fileId, {
        ranges: chunk.map(function (n) { return "'" + n.replace(/'/g, "''") + "'" + RANGE; }),
      });
      (resp.valueRanges || []).forEach(function (vr, j) {
        Array.prototype.push.apply(records, GridReader_.parseDaySheet(chunk[j], vr.values || [], info));
      });
    }
    return records;
  }

  function readDetail_(ss) {
    const byFile = {};
    const sheet = ss.getSheetByName(SHEET_DETAIL);
    if (!sheet || sheet.getLastRow() < 2) return byFile;
    sheet.getRange(2, 1, sheet.getLastRow() - 1, DETAIL_HEADERS.length).getValues().forEach(function (r) {
      const id = String(r[7]);
      (byFile[id] = byFile[id] || []).push(r);
    });
    return byFile;
  }

  function writeDetail_(ss, rows) {
    let sheet = ss.getSheetByName(SHEET_DETAIL);
    if (!sheet) sheet = ss.insertSheet(SHEET_DETAIL);
    sheet.clearContents();
    sheet.getRange(1, 1, 1, DETAIL_HEADERS.length).setValues([DETAIL_HEADERS]).setFontWeight("bold");
    sheet.setFrozenRows(1);
    if (!rows.length) return;
    const body = sheet.getRange(2, 1, rows.length, DETAIL_HEADERS.length);
    body.setNumberFormat("@"); // 番号の先頭ゼロ・時刻・日付を文字列のまま保つ
    body.setValues(rows);
  }

  function toDetailRow_(r, fileId) {
    return [r.clinic, r.date, r.time, r.staff, r.patientId, r.name, r.note, fileId];
  }

  function fromDetailRow_(r) {
    return {
      clinic: String(r[0]), date: r[1], time: String(r[2]), staff: String(r[3]),
      patientId: r[4], name: String(r[5]), note: String(r[6]), status: String(r[6]), menu: "",
    };
  }

  /**
   * 対象ファイルの予約を返す。前回読込以降に更新されたファイル（full なら全ファイル）だけ読み直す。
   * 時間切れの場合は読めた分だけ保存し、残りは次回に回す（pending に件数）。
   */
  function loadRecords(ss, config, opts) {
    const full = !!(opts && opts.full);
    const files = readFileList_(ss);
    if (!files) throw new Error("「" + SHEET_FILES + "」がありません。メニューの「予約表ファイルを検索」を先に実行してください。");

    const start = Date.now();
    const cached = readDetail_(ss);
    const targets = files.filter(function (f) { return f.checked; });
    const rows = [];
    const readAt = {};
    let filesRead = 0, pending = 0;

    targets.forEach(function (f) {
      // 明細に行が無いファイル（対象を一度外した・予約0件）も読み直す
      const stale = full || !f.lastRead || !cached[f.id] || toTime_(f.updated) > toTime_(f.lastRead);
      if (!stale || Date.now() - start > TIME_BUDGET_MS) {
        if (stale) pending++;
        Array.prototype.push.apply(rows, cached[f.id] || []);
        return;
      }
      const info = GridReader_.parseTitle(f.title, config.clinicAliases);
      if (!info.ok) return;
      fetchFile_(f.id, info).forEach(function (r) { rows.push(toDetailRow_(r, f.id)); });
      readAt[f.id] = new Date();
      filesRead++;
    });

    rows.sort(function (a, b) {
      for (let i = 0; i < 3; i++) {
        const x = String(a[i]), y = String(b[i]);
        if (x !== y) return x < y ? -1 : 1;
      }
      return 0;
    });
    writeDetail_(ss, rows);

    // 読み込んだファイルの「最終読込」を更新
    if (filesRead) {
      const sheet = ss.getSheetByName(SHEET_FILES);
      const ids = sheet.getRange(2, COL.id + 1, sheet.getLastRow() - 1, 1).getValues();
      const lastRead = sheet.getRange(2, COL.lastRead + 1, ids.length, 1);
      const values = lastRead.getValues().map(function (r, i) {
        const id = String(ids[i][0]).trim();
        return [readAt[id] || r[0]];
      });
      lastRead.setValues(values);
    }

    return { records: rows.map(fromDetailRow_), files: targets.length, filesRead: filesRead, pending: pending };
  }

  return { discoverFiles: discoverFiles, loadRecords: loadRecords, hasFileList: function (ss) { return !!readFileList_(ss); } };
})();
