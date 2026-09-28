// Classifier.gs のユニットテスト。実行: node visits/test/classifier.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "Classifier.gs"), "utf8") + "\nthis.Classifier_ = Classifier_;", ctx);
const C = ctx.Classifier_;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function rec(date, patientId, extra) {
  return Object.assign({ date, patientId, name: "", staff: "", menu: "", status: "" }, extra || {});
}
function byDate(result, date, id) {
  return result.visits.find((v) => v.date === date && v.patientId === id);
}

test("normalizeDate: 各種形式", () => {
  assert.strictEqual(C.normalizeDate("2026/9/28"), "2026-09-28");
  assert.strictEqual(C.normalizeDate("2026-09-28 10:30"), "2026-09-28");
  assert.strictEqual(C.normalizeDate("2026年9月28日"), "2026-09-28");
  assert.strictEqual(C.normalizeDate("２０２６／０９／２８"), "2026-09-28");
  assert.strictEqual(C.normalizeDate(new Date(2026, 8, 28, 15, 0)), "2026-09-28");
  assert.strictEqual(C.normalizeDate(46293), "2026-09-28"); // シリアル値
  assert.strictEqual(C.normalizeDate("2026/2/30"), "");
  assert.strictEqual(C.normalizeDate("9/28"), "");
  assert.strictEqual(C.normalizeDate(""), "");
});

test("normalizePatientId: 全角・先頭ゼロ・空白", () => {
  assert.strictEqual(C.normalizePatientId("００１２３"), "123");
  assert.strictEqual(C.normalizePatientId(123), "123");
  assert.strictEqual(C.normalizePatientId(" A-01 "), "A-01");
  assert.strictEqual(C.normalizePatientId("0"), "0");
  assert.strictEqual(C.normalizePatientId(""), "");
});

test("初来院は新患、以降は継続", () => {
  const r = C.classify([
    rec("2026-01-01", "1"),
    rec("2026-06-01", "2"),
    rec("2026-06-10", "2"),
  ], { thresholdDays: 90 });
  assert.strictEqual(byDate(r, "2026-06-01", "2").category, "新患");
  assert.strictEqual(byDate(r, "2026-06-01", "2").needsReview, false);
  const second = byDate(r, "2026-06-10", "2");
  assert.strictEqual(second.category, "継続");
  assert.strictEqual(second.gapDays, 9);
  assert.strictEqual(second.prevDate, "2026-06-01");
});

test("90日境界: 89日=継続 / 90日=お久しぶり / 91日=お久しぶり", () => {
  const r = C.classify([
    rec("2026-01-01", "a"), rec("2026-03-31", "a"), // 89日
    rec("2026-01-01", "b"), rec("2026-04-01", "b"), // 90日
    rec("2026-01-01", "c"), rec("2026-04-02", "c"), // 91日
  ], { thresholdDays: 90 });
  assert.strictEqual(byDate(r, "2026-03-31", "a").gapDays, 89);
  assert.strictEqual(byDate(r, "2026-03-31", "a").category, "継続");
  assert.strictEqual(byDate(r, "2026-04-01", "b").category, "お久しぶり");
  assert.strictEqual(byDate(r, "2026-04-02", "c").category, "お久しぶり");
});

test("お久しぶり判定は直前の来院基準（キャンセルは来院に数えない）", () => {
  const r = C.classify([
    rec("2026-01-01", "x"),
    rec("2026-03-01", "x", { status: "キャンセル" }),
    rec("2026-05-01", "x"),
  ], { thresholdDays: 90, cancelWords: ["キャンセル"] });
  assert.strictEqual(r.excluded.cancelled, 1);
  assert.strictEqual(byDate(r, "2026-05-01", "x").category, "お久しぶり");
  assert.strictEqual(byDate(r, "2026-05-01", "x").prevDate, "2026-01-01");
});

test("キャンセル語は部分一致", () => {
  const r = C.classify([
    rec("2026-01-01", "1", { status: "無断キャンセル" }),
    rec("2026-01-01", "2", { status: "来院済" }),
  ], { cancelWords: ["キャンセル"] });
  assert.strictEqual(r.excluded.cancelled, 1);
  assert.strictEqual(r.visits.length, 1);
});

test("同日重複は1来院にまとめ、担当・メニューを結合", () => {
  const r = C.classify([
    rec("2026-01-01", "1", { staff: "鈴木", menu: "整体" }),
    rec("2026-01-01", "001", { staff: "豊田", menu: "整体" }),
  ]);
  assert.strictEqual(r.visits.length, 1);
  assert.strictEqual(r.visits[0].staff, "鈴木・豊田");
  assert.strictEqual(r.visits[0].menu, "整体");
});

test("患者ID空欄・日付不正は除外", () => {
  const r = C.classify([rec("2026-01-01", ""), rec("不明", "1"), rec("2026-01-02", "2")]);
  assert.strictEqual(r.excluded.noPatientId, 1);
  assert.strictEqual(r.excluded.invalidDate, 1);
  assert.strictEqual(r.visits.length, 1);
});

test("データ開始日から閾値以内の初登場は新患（要確認）", () => {
  const r = C.classify([
    rec("2026-01-01", "a"),
    rec("2026-03-31", "b"), // 開始から89日 → 要確認
    rec("2026-04-01", "c"), // 開始から90日 → 確定
  ], { thresholdDays: 90 });
  assert.strictEqual(r.dataStart, "2026-01-01");
  assert.strictEqual(byDate(r, "2026-01-01", "a").needsReview, true);
  assert.strictEqual(byDate(r, "2026-03-31", "b").needsReview, true);
  assert.strictEqual(byDate(r, "2026-04-01", "c").needsReview, false);
});

test("入力順に依存しない", () => {
  const r = C.classify([rec("2026-06-01", "1"), rec("2026-01-01", "1")], { thresholdDays: 90 });
  assert.strictEqual(byDate(r, "2026-01-01", "1").category, "新患");
  assert.strictEqual(byDate(r, "2026-06-01", "1").category, "お久しぶり");
});

test("月次集計・担当者別集計", () => {
  const r = C.classify([
    rec("2026-01-05", "1", { staff: "鈴木" }),
    rec("2026-01-20", "1", { staff: "鈴木" }),
    rec("2026-01-20", "2", { staff: "豊田" }),
    rec("2026-05-01", "1", { staff: "豊田" }), // お久しぶり
    rec("2026-05-02", "3", { staff: "" }),     // 新患（確定）
  ], { thresholdDays: 90 });
  const s = C.summarizeMonthly(r.visits);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s.months)), [
    { month: "2026-01", total: 3, patients: 2, newConfirmed: 0, newReview: 2, returning: 0, continuing: 1 },
    { month: "2026-05", total: 2, patients: 2, newConfirmed: 1, newReview: 0, returning: 1, continuing: 0 },
  ]);
  const may = s.staff.filter((x) => x.month === "2026-05").map((x) => [x.staff, x.newConfirmed, x.returning]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(may)), [["豊田", 0, 1], ["（未設定）", 1, 0]]);
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
