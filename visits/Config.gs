/**
 * 「設定」シートの作成・読み込み。
 *
 * 設定シートは A列=項目 / B列=値 / C列=説明 の縦並び。
 * 予約表の見出し名が院のものと違う場合は B列を書き換えるだけで対応できる。
 */

const SHEET_INPUT = "予約データ";
const SHEET_CONFIG = "設定";

var Config_ = (function () {
  // [項目, 既定値, 説明]
  const ITEMS = [
    ["日付の列", "日付", "予約データ1行目の見出し名（必須）"],
    ["患者IDの列", "診察券番号", "予約データ1行目の見出し名（必須）"],
    ["氏名の列", "氏名", "見出し名（任意・無ければ空欄）"],
    ["担当の列", "担当", "見出し名（任意）"],
    ["メニューの列", "メニュー", "見出し名（任意）"],
    ["状態の列", "状態", "見出し名（任意）。キャンセル判定に使う"],
    ["キャンセル扱いの文言", "キャンセル,取消,無断", "状態の列にこの文言が含まれる行は来院に数えない（カンマ区切り）"],
    ["お久しぶり判定日数", 90, "前回来院からこの日数以上空いたら「お久しぶり」"],
  ];

  function ensureSheet(ss) {
    let sheet = ss.getSheetByName(SHEET_CONFIG);
    if (sheet) return sheet;
    sheet = ss.insertSheet(SHEET_CONFIG);
    sheet.getRange(1, 1, 1, 3).setValues([["項目", "値", "説明"]]).setFontWeight("bold");
    sheet.getRange(2, 1, ITEMS.length, 3).setValues(ITEMS);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, 3);
    return sheet;
  }

  function load(ss) {
    const sheet = ensureSheet(ss);
    const values = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 2).getValues();
    const map = {};
    values.forEach(function (r) { map[String(r[0]).trim()] = r[1]; });
    const get = function (key) {
      if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
      return ITEMS.filter(function (i) { return i[0] === key; })[0][1];
    };
    const text = function (key) { return String(get(key) === null || get(key) === undefined ? "" : get(key)).trim(); };

    return {
      columns: {
        date: text("日付の列"),
        patientId: text("患者IDの列"),
        name: text("氏名の列"),
        staff: text("担当の列"),
        menu: text("メニューの列"),
        status: text("状態の列"),
      },
      cancelWords: text("キャンセル扱いの文言").split(/[,、，]/).map(function (s) { return s.trim(); }).filter(String),
      thresholdDays: Number(get("お久しぶり判定日数")) > 0 ? Number(get("お久しぶり判定日数")) : 90,
    };
  }

  return { ensureSheet: ensureSheet, load: load, ITEMS: ITEMS };
})();
