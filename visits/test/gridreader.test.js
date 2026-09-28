// GridReader.gs のユニットテスト。実行: node visits/test/gridreader.test.js
// 予約表と同じレイアウトのダミー日タブ（氏名はすべて架空）で検証する。
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "GridReader.gs"), "utf8") + "\nthis.GridReader_ = GridReader_;", ctx);
const G = ctx.GridReader_;
const plain = (x) => JSON.parse(JSON.stringify(x));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// 実物の日タブと同じ並び: A列空、B列時刻、C〜F / G〜J / K〜N が担当ブロック、P〜T は空き状況
function dummyDaySheet() {
  const blank = (n) => Array(n).fill("");
  const slot = (time, a, b, c) => ["", time, ...(a || ["", "-", "", ""]), ...(b || ["", "-", "", ""]), ...(c || ["", "-", "", ""]), "", time, "0", "○", "○", "×"];
  return [
    ["", "DAY", ...blank(13), "0"],
    ["", "09-01（火）", "山田太郎", "", "", "", "佐藤花子", "", "", "", "田中一郎", ...blank(9)],
    ["予約\n管理表", ...blank(9), "別院", ...blank(9)],
    ["", "", "NO", "名前", "時間", "備考", "NO", "名前", "時間", "備考", "NO", "名前", "時間", "備考", "", "", "合計値", "山田", "佐藤", "田中"],
    slot("9:00", ["1581", "架空 一郎", "", ""]),
    slot("9:20"),
    slot("10:00", ["1172", "架空 二郎", "", ""], ["1734", "架空 三子", "", ""]),
    slot("10:20", null, ["1734", "架空 三子", "", ""]), // 40分予約（2枠連続）
    slot("12:00", ["990", "・", "", "西岡さん"]),
    slot("15:40", ["990", "・", "", "菅さん"]),
    slot("17:00", null, ["1738", "架空 四子", "", "保険切り替え"]),
    slot("18:00", null, null, ["2001", "架空 五郎", "", ""]),
    slot("19:00", ["", "飛び込み", "", ""]), // 番号なし（ID空欄として後で除外される）
    ["", "", "これ以上は絶対に入れないこと", ...blank(17)],
    ["", "18:20", "これ以上は絶対に入れないこと"],
    ["", "20:00", "9999", "停止後の行"],
  ];
}

test("parseTitle: 通常・複数月・末尾空白・別名", () => {
  const aliases = { "東村": "東村山" };
  assert.deepStrictEqual(plain(G.parseTitle("2026.9/Res/桜台", aliases)), { ok: true, year: 2026, months: [9], clinic: "桜台" });
  assert.deepStrictEqual(plain(G.parseTitle("2026.9.10.11/Res/桜台")).months, [9, 10, 11]);
  assert.strictEqual(G.parseTitle("2026.7/Res/Hagwaz ").clinic, "Hagwaz");
  assert.strictEqual(G.parseTitle("2026.9/Res/東村 ", aliases).clinic, "東村山");
  assert.strictEqual(G.parseTitle("2026.5/Res/東村山 ", aliases).clinic, "東村山");
});

test("parseTitle: 除外対象", () => {
  assert.deepStrictEqual(plain(G.parseTitle("原本/Res/ひばり")), { ok: false, reason: "原本（テンプレ）" });
  assert.strictEqual(G.parseTitle("原本/Res/桜台/修正版").ok, false);
  assert.strictEqual(G.parseTitle("2026.7/Res/所沢【使用禁止】").reason, "使用禁止");
  assert.strictEqual(G.parseTitle("Restore.plist").ok, false);
  assert.strictEqual(G.parseTitle("2026.13/Res/桜台").ok, false);
});

test("sheetDate: 対象月のみ・年またぎ", () => {
  const info = { year: 2026, months: [9] };
  assert.strictEqual(G.sheetDate("09-01（火）", info), "2026-09-01");
  assert.strictEqual(G.sheetDate("9-30(水)", info), "2026-09-30");
  assert.strictEqual(G.sheetDate("01-31(土)", info), ""); // 前月の残骸タブ
  assert.strictEqual(G.sheetDate("09-31（木）", info), ""); // 存在しない日
  assert.strictEqual(G.sheetDate("テンプレ", info), "");
  assert.strictEqual(G.sheetDate("顧客リスト", info), "");
  assert.strictEqual(G.sheetDate("01-05（月）", { year: 2025, months: [11, 12, 1] }), "2026-01-05");
});

test("parseDaySheet: ブロック・担当者・時刻・空き枠・停止行", () => {
  const recs = G.parseDaySheet("09-01（火）", dummyDaySheet(), { year: 2026, months: [9], clinic: "桜台" });
  const rows = recs.map((r) => [r.time, r.staff, r.patientId, r.name, r.note]);
  assert.deepStrictEqual(plain(rows), [
    ["9:00", "山田太郎", "1581", "架空 一郎", ""],
    ["10:00", "山田太郎", "1172", "架空 二郎", ""],
    ["10:00", "佐藤花子", "1734", "架空 三子", ""],
    ["10:20", "佐藤花子", "1734", "架空 三子", ""],
    ["12:00", "山田太郎", "990", "", "西岡さん"],
    ["15:40", "山田太郎", "990", "", "菅さん"],
    ["17:00", "佐藤花子", "1738", "架空 四子", "保険切り替え"],
    ["18:00", "田中一郎（別院）", "2001", "架空 五郎", ""],
    ["19:00", "山田太郎", "", "飛び込み", ""],
  ]);
  assert.ok(recs.every((r) => r.clinic === "桜台" && r.date === "2026-09-01"));
});

test("parseDaySheet: 対象外タブ・見出しなし・空", () => {
  const info = { year: 2026, months: [9], clinic: "桜台" };
  assert.strictEqual(G.parseDaySheet("01-31(土)", dummyDaySheet(), info).length, 0);
  assert.strictEqual(G.parseDaySheet("09-02（水）", [["a", "b"], ["c"]], info).length, 0);
  assert.strictEqual(G.parseDaySheet("09-02（水）", [], info).length, 0);
  assert.strictEqual(G.parseDaySheet("09-02（水）", undefined, info).length, 0);
});

let failed = 0;
tests.forEach(({ name, fn }) => {
  try {
    fn();
    console.log("ok   - " + name);
  } catch (e) {
    failed++;
    console.log("FAIL - " + name + "\n       " + e.message.split("\n").join("\n       "));
  }
});
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
