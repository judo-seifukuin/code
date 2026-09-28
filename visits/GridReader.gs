/**
 * 予約表（ドライブ上の「YYYY.M/Res/院名」スプレッドシート）の解析。GAS API 非依存の純粋関数のみ。
 *
 * 予約表の構造:
 *   - 院×月ごとに1ファイル。名前は "2026.9/Res/桜台"（複数月は "2026.9.10.11/Res/桜台"）
 *   - 1日1タブ。タブ名は "09-01（火）"（年は無い → ファイル名の年を使う）
 *   - 日タブの中は時間枠×担当者のグリッド:
 *       2行目      … 各担当ブロックの先頭列に担当者名
 *       見出し行   … 担当ごとに「NO | 名前 | 時間 | 備考」の4列ブロック
 *       以降の行   … B列に時刻（9:00, 9:20, …）、各ブロックに NO（診察券番号）/ 名前 / 時間 / 備考
 *       空き枠は名前が "-"。末尾に「これ以上は絶対に入れないこと」の行がある
 */

var GridReader_ = (function () {
  const DAY_SHEET = /^\s*(\d{1,2})\s*-\s*(\d{1,2})/;
  const TIME = /^\s*\d{1,2}:\d{2}/;
  const STOP_WORD = "これ以上";
  const EMPTY_NAMES = ["", "-", "－", "ー", "・"];

  function text_(v) {
    return v === null || v === undefined ? "" : String(v).trim();
  }

  /**
   * ファイル名を解析する。
   * @param {string} title
   * @param {Object<string,string>=} aliases 院名の別名 { "東村": "東村山" }
   * @return {{ok: true, year: number, months: number[], clinic: string} | {ok: false, reason: string}}
   */
  function parseTitle(title, aliases) {
    const t = text_(title);
    if (/^原本/.test(t)) return { ok: false, reason: "原本（テンプレ）" };
    if (t.indexOf("使用禁止") !== -1) return { ok: false, reason: "使用禁止" };
    if (t.indexOf("修正版") !== -1) return { ok: false, reason: "修正版" };
    const m = /^(\d{4})\.(\d{1,2}(?:\.\d{1,2})*)\/Res\/([^\/【]+)/.exec(t);
    if (!m) return { ok: false, reason: "ファイル名の形式が「年.月/Res/院名」ではない" };
    const months = m[2].split(".").map(Number);
    if (months.some(function (n) { return n < 1 || n > 12; })) return { ok: false, reason: "月が不正" };
    let clinic = m[3].trim();
    if (aliases && Object.prototype.hasOwnProperty.call(aliases, clinic)) clinic = aliases[clinic];
    return { ok: true, year: Number(m[1]), months: months, clinic: clinic };
  }

  /**
   * タブ名から日付を求める。対象外のタブ（テンプレ・顧客リスト・前月の残骸タブ等）は "" を返す。
   * @param {string} sheetName
   * @param {{year: number, months: number[]}} fileInfo
   */
  function sheetDate(sheetName, fileInfo) {
    const m = DAY_SHEET.exec(text_(sheetName));
    if (!m) return "";
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (fileInfo.months.indexOf(month) === -1) return "";
    // 複数月ファイルが年をまたぐ場合（"2026.11.12.1"）、先頭月より小さい月は翌年
    const year = month < fileInfo.months[0] ? fileInfo.year + 1 : fileInfo.year;
    const t = new Date(Date.UTC(year, month - 1, day));
    if (t.getUTCMonth() !== month - 1 || t.getUTCDate() !== day) return "";
    return year + "-" + (month < 10 ? "0" : "") + month + "-" + (day < 10 ? "0" : "") + day;
  }

  function isDaySheetName(sheetName) {
    return DAY_SHEET.test(text_(sheetName));
  }

  // 見出し行（「NO」の右隣が「名前」のセルを含む行）と各ブロックの先頭列を探す
  function findHeader_(values) {
    for (let r = 0; r < values.length; r++) {
      const row = values[r] || [];
      const cols = [];
      for (let c = 0; c < row.length - 1; c++) {
        if (text_(row[c]).toUpperCase() === "NO" && text_(row[c + 1]) === "名前") cols.push(c);
      }
      if (cols.length) return { row: r, cols: cols };
    }
    return null;
  }

  // 担当者名: 見出し行より上で、そのブロック列にある文字列。一番上を担当名、残り（「別院」等）は括弧書き
  function staffName_(values, headerRow, col) {
    const labels = [];
    for (let r = 0; r < headerRow; r++) {
      const s = text_((values[r] || [])[col]);
      if (s) labels.push(s);
    }
    if (!labels.length) return "";
    return labels[0] + (labels.length > 1 ? "（" + labels.slice(1).join("・") + "）" : "");
  }

  /**
   * 日タブ1枚分を予約レコードに変換する。
   * @param {string} sheetName
   * @param {Array<Array<*>>} values タブの値（Sheets API の values そのまま。行ごとに長さが違ってよい）
   * @param {{year: number, months: number[], clinic: string}} fileInfo
   * @return {Array<{clinic, date, time, staff, patientId, name, note, status}>}
   */
  function parseDaySheet(sheetName, values, fileInfo) {
    const date = sheetDate(sheetName, fileInfo);
    if (!date || !values || !values.length) return [];
    const header = findHeader_(values);
    if (!header) return [];

    const blocks = header.cols.map(function (c) {
      return { col: c, staff: staffName_(values, header.row, c) };
    });

    const records = [];
    for (let r = header.row + 1; r < values.length; r++) {
      const row = values[r] || [];
      if (row.some(function (v) { return text_(v).indexOf(STOP_WORD) !== -1; })) break;

      // 時刻は最初のブロックより左の列から拾う（通常は B 列）
      let time = "";
      for (let c = 0; c < header.cols[0]; c++) {
        if (TIME.test(text_(row[c]))) { time = text_(row[c]); break; }
      }

      blocks.forEach(function (b) {
        const no = text_(row[b.col]);
        const name = text_(row[b.col + 1]);
        if (!no && EMPTY_NAMES.indexOf(name) !== -1) return; // 空き枠
        const note = text_(row[b.col + 3]);
        records.push({
          clinic: fileInfo.clinic,
          date: date,
          time: time,
          staff: b.staff,
          patientId: no,
          name: EMPTY_NAMES.indexOf(name) !== -1 ? "" : name,
          note: note,
          status: note,
        });
      });
    }
    return records;
  }

  return {
    parseTitle: parseTitle,
    sheetDate: sheetDate,
    isDaySheetName: isDaySheetName,
    parseDaySheet: parseDaySheet,
  };
})();
