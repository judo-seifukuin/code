// GAS API をモックし、設定→予約データ読込→判定→出力シート書き込みまでを通すテスト。
// 実行: node visits/test/report.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ---- 最小限のスプレッドシートモック ----
class FakeRange {
  constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr, nc }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const line = [];
      for (let c = 0; c < this.nc; c++) {
        const v = (this.sheet.cells[this.row - 1 + r] || [])[this.col - 1 + c];
        line.push(v === undefined ? "" : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    assert.strictEqual(values.length, this.nr, "setValues: 行数不一致");
    values.forEach((line, r) => {
      assert.strictEqual(line.length, this.nc, "setValues: 列数不一致");
      const target = (this.sheet.cells[this.row - 1 + r] = this.sheet.cells[this.row - 1 + r] || []);
      line.forEach((v, c) => { target[this.col - 1 + c] = v; });
    });
    return this;
  }
  setNumberFormats(f) {
    assert.strictEqual(f.length, this.nr);
    f.forEach((line) => assert.strictEqual(line.length, this.nc));
    return this;
  }
  setFontWeight() { return this; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.cells = []; this.charts = []; }
  getName() { return this.name; }
  getRange(r, c, nr, nc) { return new FakeRange(this, r, c, nr || 1, nc || 1); }
  getLastRow() {
    for (let i = this.cells.length - 1; i >= 0; i--) {
      if ((this.cells[i] || []).some((v) => v !== "" && v !== undefined)) return i + 1;
    }
    return 0;
  }
  getLastColumn() { return this.cells.reduce((m, row) => Math.max(m, (row || []).length), 0); }
  appendRow(row) { this.getRange(this.getLastRow() + 1, 1, 1, row.length).setValues([row]); }
  clearContents() { this.cells = []; }
  getCharts() { return this.charts.slice(); }
  removeChart(c) { this.charts = this.charts.filter((x) => x !== c); }
  insertChart(c) { this.charts.push(c); }
  newChart() {
    const b = { ranges: [], options: {} };
    const builder = {
      setChartType: () => builder,
      addRange: (r) => { b.ranges.push(r); return builder; },
      setPosition: () => builder,
      setOption: (k, v) => { b.options[k] = v; return builder; },
      build: () => b,
    };
    return builder;
  }
  setFrozenRows() {}
  autoResizeColumns() {}
}

class FakeSpreadsheet {
  constructor() { this.sheets = []; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new FakeSheet(n); this.sheets.push(s); return s; }
}

function loadGas() {
  const ctx = {
    console,
    LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Charts: { ChartType: { COLUMN: "COLUMN" } },
  };
  vm.createContext(ctx);
  const dir = path.join(__dirname, "..");
  const src = ["Classifier.gs", "Config.gs", "Reader.gs", "Report.gs"]
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  vm.runInContext(src + "\nthis.Config_ = Config_; this.Reader_ = Reader_; this.Report_ = Report_;", ctx);
  return ctx;
}

function loadSampleCsv() {
  const text = fs.readFileSync(path.join(__dirname, "..", "sample", "reservations-sample.csv"), "utf8");
  return text.trim().split("\n").map((line) => line.split(","));
}

// ---- テスト ----
const gas = loadGas();
const ss = new FakeSpreadsheet();
gas.Config_.ensureSheet(ss);
const input = gas.Reader_.ensureInputSheet(ss, gas.Config_.load(ss));
assert.deepStrictEqual(input.getRange(1, 1, 1, 6).getValues()[0], ["日付", "診察券番号", "氏名", "担当", "メニュー", "状態"]);

// 予約表からの貼り付けを模擬（「時間」列など余分な列があっても見出し名で拾える）
const csv = loadSampleCsv();
input.clearContents();
input.getRange(1, 1, csv.length, csv[0].length).setValues(csv);

const res = gas.Report_.run(ss, "手動");
assert.ok(res.ok, res.message);
console.log(res.message + "\n");

const rows = (name) => {
  const s = ss.getSheetByName(name);
  return s.getRange(2, 1, s.getLastRow() - 1, s.getLastColumn()).getValues();
};
// vm 内で作られた Date は別レルムなので instanceof ではなく toString で判定する
const fmt = (d) => (Object.prototype.toString.call(d) === "[object Date]" ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : d);

const log = rows("来院ログ");
assert.strictEqual(log.length, 16, "来院数");
const extract = rows("抽出リスト").map((r) => [fmt(r[0]), r[1], r[3], r[5]]);
assert.deepStrictEqual(extract, [
  ["2026-09-14", "1009", "新患", ""],
  ["2026-09-07", "1007", "お久しぶり", 119],
  ["2026-08-03", "1004", "お久しぶり", 154],
  ["2026-07-06", "1008", "新患", ""],
  ["2026-05-11", "1007", "新患", ""],
  ["2026-04-20", "1001", "お久しぶり", 91],
  ["2026-04-19", "1002", "お久しぶり", 104],
  ["2026-04-06", "1005", "新患", ""],
  ["2026-03-02", "1004", "新患（要確認）", ""],
  ["2026-02-02", "1003", "新患（要確認）", ""],
  ["2026-01-05", "1001", "新患（要確認）", ""],
  ["2026-01-05", "1002", "新患（要確認）", ""],
]);
// 同日2件（1007 / 01007）は1来院に集約され、メニューが結合される
const merged = rows("来院ログ").find((r) => fmt(r[0]) === "2026-05-11");
assert.strictEqual(merged[7], "保険施術・自費整体");
// キャンセルを挟んでも 1003 の 5/1 は 2/2 から 88 日で継続
const r1003 = log.find((r) => fmt(r[0]) === "2026-05-01");
assert.deepStrictEqual([r1003[3], r1003[5]], ["継続", 88]);

const monthly = rows("月次集計");
assert.deepStrictEqual(monthly.map((r) => r[0]), ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
const apr = monthly.find((r) => r[0] === "2026-04");
assert.deepStrictEqual(apr.slice(1, 7), [3, 3, 1, 0, 2, 0]); // 延べ3 / 実3 / 新患1 / 要確認0 / お久しぶり2 / 継続0
assert.strictEqual(ss.getSheetByName("月次集計").charts.length, 1);

const runlog = rows("実行ログ");
assert.deepStrictEqual(runlog[0].slice(1, 10), ["手動", 20, 16, 4, 4, 4, 2, 1, 0]);

// 再実行しても結果は同じ（冪等）でグラフは1つのまま、実行ログは追記
assert.ok(gas.Report_.run(ss, "自動").ok);
assert.strictEqual(rows("抽出リスト").length, 12);
assert.strictEqual(ss.getSheetByName("月次集計").charts.length, 1);
assert.strictEqual(rows("実行ログ").length, 2);

// 予約データの見出しが設定と違う場合は分かりやすいエラー
input.getRange(1, 3, 1, 1).setValues([["患者番号"]]);
const bad = gas.Report_.run(ss, "手動");
assert.strictEqual(bad.ok, false);
assert.match(bad.message, /見出し「診察券番号」が見つかりません/);
assert.match(rows("実行ログ")[2][11], /^エラー:/);

console.log("report.test.js: all passed");
