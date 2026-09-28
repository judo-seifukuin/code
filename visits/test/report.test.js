// GAS API をモックし、予約表ファイル検索 → 日タブ読込 → 判定 → 出力シート書き込み → 差分読込 までを通すテスト。
// 予約表はダミー（氏名はすべて架空）。実行: node visits/test/report.test.js
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
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  insertCheckboxes() { return this.setValues(Array.from({ length: this.nr }, () => Array(this.nc).fill(false))); }
  clearDataValidations() { return this; }
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
  getMaxRows() { return Math.max(1000, this.cells.length); }
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

// ---- ダミー予約表（実物と同じグリッド: B列時刻、担当ごとに NO/名前/時間/備考 の4列） ----
const STAFF = ["山田太郎", "佐藤花子"];
// bookings: [時刻, 担当index, NO, 名前, 備考]
function dayGrid(label, bookings) {
  const times = ["9:00", "9:20", "9:40", "10:00", "10:20"];
  const rows = [
    ["", "DAY"],
    ["", label, STAFF[0], "", "", "", STAFF[1]],
    ["予約\n管理表"],
    ["", "", "NO", "名前", "時間", "備考", "NO", "名前", "時間", "備考", "", "", "合計値"],
  ];
  times.forEach((t) => {
    const row = ["", t, "", "-", "", "", "", "-", "", "", "", t, "0"];
    bookings.filter((b) => b[0] === t).forEach(([, s, no, name, note]) => {
      row.splice(2 + s * 4, 4, no, name, "", note || "");
    });
    rows.push(row);
  });
  rows.push(["", "", "これ以上は絶対に入れないこと"]);
  return rows;
}

let now = new Date(2026, 8, 28, 9, 0);
const files = [
  {
    id: "A", name: "2026.1/Res/桜台", updated: new Date(2026, 1, 1),
    sheets: {
      "テンプレ": dayGrid("テンプレ", [["9:00", 0, "9999", "テンプレの人"]]),
      "12-31(水)": dayGrid("12-31", [["9:00", 0, "8888", "残骸タブの人"]]),
      "01-05（月）": dayGrid("01-05", [["9:00", 0, "1001", "架空 一郎"], ["9:00", 1, "1002", "架空 二郎"]]),
      "01-19（月）": dayGrid("01-19", [["9:20", 0, "1001", "架空 一郎"]]),
      "顧客リスト": [["NO", "名前"], ["1001", "架空 一郎"]],
    },
  },
  {
    id: "B", name: "2026.5/Res/桜台", updated: new Date(2026, 5, 1),
    sheets: {
      "05-01（金）": dayGrid("05-01", [
        ["9:00", 0, "1001", "架空 一郎"],          // 1/19 から 102 日 → お久しぶり
        ["9:00", 1, "1003", "架空 三子"],          // 新患（桜台データ開始から 116 日 → 確定）
        ["9:40", 0, "990", "・", "西岡さん"],       // 番号未発行
      ]),
      "05-11（月）": dayGrid("05-11", [["10:00", 1, "1003", "架空 三子"], ["10:20", 1, "1003", "架空 三子"]]), // 2枠連続
      "05-20（水）": dayGrid("05-20", [["9:00", 0, "1002", "架空 二郎", "キャンセル"]]),
    },
  },
  {
    id: "C", name: "2026.5/Res/東村 ", updated: new Date(2026, 5, 1),
    sheets: {
      "05-02（土）": dayGrid("05-02", [["9:00", 0, "1001", "別人 一郎"]]), // 東村山の 1001 は桜台とは別人
      "05-09（土）": dayGrid("05-09", [["9:00", 1, "1001", "別人 一郎"]]),
    },
  },
  { id: "D", name: "原本/Res/桜台", updated: new Date(2026, 5, 1), sheets: {} },
  { id: "E", name: "2026.7/Res/所沢【使用禁止】", updated: new Date(2026, 5, 1), sheets: {} },
];

const calls = { get: 0, batchGet: 0 };
function loadGas() {
  const ctx = {
    console,
    Charts: { ChartType: { COLUMN: "COLUMN" } },
    DriveApp: {
      searchFiles: (q) => {
        assert.match(q, /title contains "\/Res\/"/);
        const list = files.slice();
        return {
          hasNext: () => list.length > 0,
          next: () => { const f = list.shift(); return { getId: () => f.id, getName: () => f.name, getLastUpdated: () => f.updated }; },
        };
      },
    },
    Sheets: {
      Spreadsheets: {
        get: (id) => { calls.get++; return { sheets: Object.keys(files.find((f) => f.id === id).sheets).map((t) => ({ properties: { title: t } })) }; },
        Values: {
          batchGet: (id, { ranges }) => {
            calls.batchGet++;
            const f = files.find((x) => x.id === id);
            return {
              valueRanges: ranges.map((r) => {
                const m = /^'(.*)'!/.exec(r);
                assert.ok(m, "range はシート名をクォートする: " + r);
                const v = f.sheets[m[1].replace(/''/g, "'")];
                return v ? { range: r, values: v } : { range: r };
              }),
            };
          },
        },
      },
    },
  };
  vm.createContext(ctx);
  const dir = path.join(__dirname, "..");
  const src = ["Classifier.gs", "GridReader.gs", "Config.gs", "Reader.gs", "Source.gs", "Report.gs"]
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  vm.runInContext(src + "\nthis.Config_ = Config_; this.Source_ = Source_; this.Report_ = Report_;", ctx);
  ctx.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(now.getTime()); } };
  return ctx;
}

const isDate = (d) => Object.prototype.toString.call(d) === "[object Date]";
const fmt = (d) => (isDate(d) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : d);
const plain = (x) => JSON.parse(JSON.stringify(x));

// ---- テスト ----
const gas = loadGas();
const ss = new FakeSpreadsheet();
const rows = (name) => {
  const s = ss.getSheetByName(name);
  const n = s.getLastRow() - 1;
  return n > 0 ? s.getRange(2, 1, n, s.getLastColumn()).getValues() : [];
};

// 1. ファイル検索
gas.Config_.ensureSheet(ss);
const found = gas.Source_.discoverFiles(ss, gas.Config_.load(ss));
assert.deepStrictEqual(plain(found), { total: 5, targets: 3, excluded: 2, clinics: ["東村山", "桜台"] });
const list = rows("ファイル一覧");
assert.deepStrictEqual(plain(list.map((r) => [r[0], r[1], r[3], r[5]])), [
  [true, "東村山", "5", "C"],
  [true, "桜台", "1", "A"],
  [true, "桜台", "5", "B"],
  [false, "", "", "E"],
  [false, "", "", "D"],
]);
assert.match(list[3][8], /使用禁止/);
assert.match(list[4][8], /原本/);

// 2. 初回集計（全ファイル読込）
let res = gas.Report_.run(ss, "手動", { full: false });
assert.ok(res.ok, res.message);
console.log(res.message + "\n");
assert.deepStrictEqual(calls, { get: 3, batchGet: 3 });

const detail = rows("予約明細");
assert.strictEqual(detail.length, 11, "予約明細（テンプレ・残骸タブ・顧客リストは読まない）");

const extract = rows("抽出リスト").map((r) => [r[0], fmt(r[1]), r[2], r[4], r[6]]);
assert.deepStrictEqual(plain(extract), [
  ["東村山", "2026-05-02", "1001", "新患（要確認）", ""],
  ["桜台", "2026-05-01", "1001", "お久しぶり", 102],
  ["桜台", "2026-05-01", "1003", "新患", ""],
  ["桜台", "2026-05-01", "990", "新患（番号未発行）", ""],
  ["桜台", "2026-01-05", "1001", "新患（要確認）", ""],
  ["桜台", "2026-01-05", "1002", "新患（要確認）", ""],
]);
const log = rows("来院ログ");
assert.strictEqual(log.length, 9, "来院数（2枠連続は1来院、キャンセルは除外）");
assert.strictEqual(log.find((r) => r[2] === "990")[8], "西岡さん");

const monthly = rows("月次集計");
assert.deepStrictEqual(plain(monthly.map((r) => r.slice(0, 9))), [
  ["全院", "2026-01", 3, 2, 0, 2, 0, 0, 1],
  ["全院", "2026-05", 6, 4, 1, 1, 1, 1, 2],
  ["東村山", "2026-05", 2, 1, 0, 1, 0, 0, 1],
  ["桜台", "2026-01", 3, 2, 0, 2, 0, 0, 1],
  ["桜台", "2026-05", 4, 3, 1, 0, 1, 1, 1],
]);
const chart = ss.getSheetByName("月次集計").charts[0];
assert.strictEqual(chart.ranges[0].nr, 3, "グラフは全院の2か月分＋見出し");
assert.match(chart.options.title, /全院/);

const staff = rows("担当者別").filter((r) => r[0] === "桜台" && r[1] === "2026-05");
assert.deepStrictEqual(plain(staff.map((r) => [r[2], r[3], r[4], r[6], r[7]])), [["佐藤花子", 2, 1, 0, 0], ["山田太郎", 2, 0, 1, 1]]);

let runlog = rows("実行ログ");
assert.deepStrictEqual(plain(runlog[0].slice(1, 13)), ["手動", 3, 3, 11, 9, 1, 3, 1, 1, 1, 0, 0]);
assert.ok(rows("ファイル一覧").slice(0, 3).every((r) => isDate(r[7])), "最終読込が記録される");

// 3. 変更なしで再実行 → 予約表は読まない（明細を再利用）、結果は同じ
now = new Date(2026, 8, 29, 5, 0);
res = gas.Report_.run(ss, "自動", { full: false });
assert.ok(res.ok, res.message);
assert.deepStrictEqual(calls, { get: 3, batchGet: 3 });
assert.strictEqual(rows("抽出リスト").length, 6);
assert.strictEqual(ss.getSheetByName("月次集計").charts.length, 1);

// 4. 桜台5月だけ更新 → そのファイルだけ読み直す
files[1].sheets["05-25（月）"] = dayGrid("05-25", [["9:00", 0, "1004", "架空 四郎"]]);
files[1].updated = new Date(2026, 8, 29, 10, 0);
gas.Source_.discoverFiles(ss, gas.Config_.load(ss));
now = new Date(2026, 8, 29, 11, 0);
res = gas.Report_.run(ss, "手動", { full: false });
assert.ok(res.ok, res.message);
assert.deepStrictEqual(calls, { get: 4, batchGet: 4 });
assert.strictEqual(rows("予約明細").length, 12);
assert.ok(rows("抽出リスト").some((r) => r[2] === "1004" && r[4] === "新患"));

// 5. 東村山の対象を外す → 検索し直してもチェック状態は保持、集計から外れる
const fileSheet = ss.getSheetByName("ファイル一覧");
fileSheet.getRange(2, 1, 1, 1).setValues([[false]]);
gas.Source_.discoverFiles(ss, gas.Config_.load(ss));
assert.strictEqual(rows("ファイル一覧")[0][0], false);
res = gas.Report_.run(ss, "手動", { full: false });
assert.ok(res.ok);
assert.ok(rows("来院ログ").every((r) => r[0] === "桜台"));
assert.ok(rows("月次集計").every((r) => r[0] === "桜台"), "院が1つなら全院行なし");

// 6. 全読込 → 対象ファイルをすべて読み直す
res = gas.Report_.run(ss, "手動（全読込）", { full: true });
assert.ok(res.ok);
assert.deepStrictEqual(calls, { get: 6, batchGet: 6 });

// 7. ファイル一覧が無ければ分かりやすいエラー
const ss2 = new FakeSpreadsheet();
const bad = gas.Report_.run(ss2, "手動", {});
assert.strictEqual(bad.ok, false);
assert.match(bad.message, /予約表ファイルを検索/);
assert.match(ss2.getSheetByName("実行ログ").getRange(2, 15, 1, 1).getValues()[0][0], /^エラー:/);

console.log("report.test.js: all passed");
