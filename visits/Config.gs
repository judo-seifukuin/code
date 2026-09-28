/**
 * 「設定」シートの作成・読み込み。
 *
 * 設定シートは A列=項目 / B列=値 / C列=説明 の縦並び。
 * 後から項目が増えた場合は、既存シートの末尾に不足項目だけ追記する（入力済みの値は消さない）。
 */

const SHEET_INPUT = "予約データ";
const SHEET_CONFIG = "設定";

var Config_ = (function () {
  // [項目, 既定値, 説明]
  const ITEMS = [
    ["お久しぶり判定日数", 90, "前回来院からこの日数以上空いたら「お久しぶり」"],
    ["キャンセル扱いの文言", "キャンセル,取消,無断", "備考（貼り付けデータは状態の列）にこの文言を含む予約は来院に数えない（カンマ区切り）"],
    ["仮番号", "990", "番号未発行の新患に使う仮の診察券番号（カンマ区切り）。「新患（番号未発行）」として別集計"],
    ["院名の別名", "東村=東村山", "ファイル名の院名の表記ゆれをまとめる（別名=正式名、カンマ区切り）"],
    ["番号を全院共通として扱う", "いいえ", "「はい」なら別の院でも同じ番号は同じ患者とみなす"],
    ["日付の列", "日付", "【貼り付けデータ用】予約データ1行目の見出し名"],
    ["患者IDの列", "診察券番号", "【貼り付けデータ用】見出し名"],
    ["氏名の列", "氏名", "【貼り付けデータ用】見出し名（任意）"],
    ["担当の列", "担当", "【貼り付けデータ用】見出し名（任意）"],
    ["メニューの列", "メニュー", "【貼り付けデータ用】見出し名（任意）"],
    ["状態の列", "状態", "【貼り付けデータ用】見出し名（任意）"],
    ["院の列", "院", "【貼り付けデータ用】見出し名（任意）"],
  ];

  function ensureSheet(ss) {
    let sheet = ss.getSheetByName(SHEET_CONFIG);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_CONFIG);
      sheet.getRange(1, 1, 1, 3).setValues([["項目", "値", "説明"]]).setFontWeight("bold");
      sheet.setFrozenRows(1);
    }
    const lastRow = sheet.getLastRow();
    const existing = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function (r) { return String(r[0]).trim(); }) : [];
    const missing = ITEMS.filter(function (i) { return existing.indexOf(i[0]) === -1; });
    if (missing.length) {
      sheet.getRange(Math.max(lastRow, 1) + 1, 1, missing.length, 3).setValues(missing);
      sheet.autoResizeColumns(1, 3);
    }
    return sheet;
  }

  function splitList_(s) {
    return String(s).split(/[,、，]/).map(function (x) { return x.trim(); }).filter(String);
  }

  function load(ss) {
    const sheet = ensureSheet(ss);
    const values = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 2).getValues();
    const map = {};
    values.forEach(function (r) { map[String(r[0]).trim()] = r[1]; });
    const text = function (key) {
      const v = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : ITEMS.filter(function (i) { return i[0] === key; })[0][1];
      return String(v === null || v === undefined ? "" : v).trim();
    };

    const aliases = {};
    splitList_(text("院名の別名")).forEach(function (pair) {
      const p = pair.split(/[=＝]/);
      if (p.length === 2 && p[0].trim() && p[1].trim()) aliases[p[0].trim()] = p[1].trim();
    });

    return {
      thresholdDays: Number(text("お久しぶり判定日数")) > 0 ? Number(text("お久しぶり判定日数")) : 90,
      cancelWords: splitList_(text("キャンセル扱いの文言")),
      tempIds: splitList_(text("仮番号")),
      clinicAliases: aliases,
      sharedIds: /^(はい|yes|true|1|共通)$/i.test(text("番号を全院共通として扱う")),
      columns: {
        date: text("日付の列"),
        patientId: text("患者IDの列"),
        name: text("氏名の列"),
        staff: text("担当の列"),
        menu: text("メニューの列"),
        status: text("状態の列"),
        clinic: text("院の列"),
      },
    };
  }

  return { ensureSheet: ensureSheet, load: load, ITEMS: ITEMS };
})();
