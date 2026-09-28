/**
 * 来院区分の判定ロジック（GAS API に依存しない純粋関数のみ）。
 *
 * 入力は Reader が作る正規化済みレコード:
 *   { date, patientId, name, staff, menu, status }
 *   date は "yyyy-MM-dd" 文字列（normalizeDate で変換済み）
 *
 * 区分:
 *   - 新患:       その患者の最初の来院
 *   - お久しぶり: 前回来院から thresholdDays 日以上空いた来院
 *   - 継続:       それ以外
 *
 * データ開始日（最古の来院日）から thresholdDays 日以内に初登場した患者は、
 * それ以前から通っていた可能性を否定できないため needsReview = true とする。
 *
 * Node からも vm で読み込んでテストできるよう、GAS のグローバル（SpreadsheetApp 等）は使わない。
 */

var Classifier_ = (function () {
  const CATEGORY = { NEW: "新患", RETURNING: "お久しぶり", CONTINUING: "継続" };
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  function pad2_(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function toYmd_(y, m, d) {
    // 存在しない日付（2/30 等）を弾く
    const t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return "";
    return y + "-" + pad2_(m) + "-" + pad2_(d);
  }

  function toHalfWidth_(s) {
    return s
      .replace(/[０-９Ａ-Ｚａ-ｚ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); })
      .replace(/[／－―]/g, function (c) { return c === "／" ? "/" : "-"; });
  }

  /**
   * セル値を "yyyy-MM-dd" に正規化する。解釈できなければ "" を返す。
   * 対応: Date オブジェクト / シリアル値 / "2026/9/28" "2026-09-28" "2026.9.28" "2026年9月28日"（時刻付きも可）
   */
  function normalizeDate(value) {
    if (value === null || value === undefined || value === "") return "";
    if (Object.prototype.toString.call(value) === "[object Date]") {
      if (isNaN(value.getTime())) return "";
      // GAS ではスクリプトのタイムゾーン（Asia/Tokyo）で解釈される
      return toYmd_(value.getFullYear(), value.getMonth() + 1, value.getDate());
    }
    if (typeof value === "number") {
      // スプレッドシートのシリアル値（1899-12-30 起点）
      if (value < 1) return "";
      const t = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * MS_PER_DAY);
      return toYmd_(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    }
    const s = toHalfWidth_(String(value).trim());
    const m = /^(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/.exec(s);
    if (!m) return "";
    return toYmd_(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  /**
   * 患者IDを正規化する。全角→半角、前後空白除去。
   * 数字のみの ID は先頭ゼロを除去する（"00123" と 123 を同一視。セルの書式ゆれ対策）。
   */
  function normalizePatientId(value) {
    if (value === null || value === undefined) return "";
    const s = toHalfWidth_(String(value)).replace(/\s+/g, "");
    if (/^\d+$/.test(s)) return s.replace(/^0+(?=\d)/, "");
    return s;
  }

  function dayNumber_(ymd) {
    const p = ymd.split("-");
    return Math.round(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / MS_PER_DAY);
  }

  function isCancelled_(status, cancelWords) {
    const s = String(status || "").trim();
    if (!s) return false;
    return cancelWords.some(function (w) { return w && s.indexOf(w) !== -1; });
  }

  function joinDistinct_(values) {
    const seen = [];
    values.forEach(function (v) {
      const s = String(v || "").trim();
      if (s && seen.indexOf(s) === -1) seen.push(s);
    });
    return seen.join("・");
  }

  /**
   * @param {Array<Object>} records 正規化済みレコード
   * @param {{thresholdDays?: number, cancelWords?: string[]}} options
   * @return {{visits: Array<Object>, excluded: Object, dataStart: string, dataEnd: string}}
   */
  function classify(records, options) {
    const opts = options || {};
    const threshold = Number(opts.thresholdDays) > 0 ? Number(opts.thresholdDays) : 90;
    const cancelWords = (opts.cancelWords || []).map(function (w) { return String(w).trim(); });
    const excluded = { cancelled: 0, noPatientId: 0, invalidDate: 0 };

    // 1. 除外 + 同日重複の集約（患者ID×日付で1来院）
    const byKey = {};
    records.forEach(function (r) {
      if (isCancelled_(r.status, cancelWords)) { excluded.cancelled++; return; }
      const id = normalizePatientId(r.patientId);
      if (!id) { excluded.noPatientId++; return; }
      const date = normalizeDate(r.date);
      if (!date) { excluded.invalidDate++; return; }
      const key = id + "\u0000" + date;
      if (!byKey[key]) byKey[key] = { patientId: id, date: date, names: [], staffs: [], menus: [] };
      byKey[key].names.push(r.name);
      byKey[key].staffs.push(r.staff);
      byKey[key].menus.push(r.menu);
    });

    const merged = Object.keys(byKey).map(function (k) {
      const v = byKey[k];
      return {
        patientId: v.patientId,
        date: v.date,
        name: joinDistinct_(v.names),
        staff: joinDistinct_(v.staffs),
        menu: joinDistinct_(v.menus),
      };
    });
    if (!merged.length) return { visits: [], excluded: excluded, dataStart: "", dataEnd: "" };

    merged.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.patientId < b.patientId ? -1 : a.patientId > b.patientId ? 1 : 0;
    });
    const dataStart = merged[0].date;
    const dataEnd = merged[merged.length - 1].date;
    const startDay = dayNumber_(dataStart);

    // 2. 日付昇順に走査し、患者ごとの前回来院日と比較
    const lastVisit = {};
    const visits = merged.map(function (v) {
      const day = dayNumber_(v.date);
      const prev = lastVisit[v.patientId];
      let category, gapDays = null, prevDate = "", needsReview = false;
      if (!prev) {
        category = CATEGORY.NEW;
        needsReview = day - startDay < threshold;
      } else {
        gapDays = day - prev.day;
        prevDate = prev.date;
        category = gapDays >= threshold ? CATEGORY.RETURNING : CATEGORY.CONTINUING;
      }
      lastVisit[v.patientId] = { day: day, date: v.date };
      return {
        date: v.date,
        patientId: v.patientId,
        name: v.name,
        staff: v.staff,
        menu: v.menu,
        category: category,
        prevDate: prevDate,
        gapDays: gapDays,
        needsReview: needsReview,
      };
    });

    return { visits: visits, excluded: excluded, dataStart: dataStart, dataEnd: dataEnd };
  }

  /**
   * 月次集計。
   * @return {{months: Array<Object>, staff: Array<Object>}}
   *   months: { month, total, patients, newConfirmed, newReview, returning, continuing }
   *   staff:  { month, staff, total, newConfirmed, newReview, returning }
   */
  function summarizeMonthly(visits) {
    const months = {};
    const staff = {};
    visits.forEach(function (v) {
      const month = v.date.slice(0, 7);
      if (!months[month]) {
        months[month] = { month: month, total: 0, patientSet: {}, newConfirmed: 0, newReview: 0, returning: 0, continuing: 0 };
      }
      const m = months[month];
      m.total++;
      m.patientSet[v.patientId] = true;
      bump_(m, v);

      const staffName = v.staff || "（未設定）";
      const sk = month + "\u0000" + staffName;
      if (!staff[sk]) staff[sk] = { month: month, staff: staffName, total: 0, newConfirmed: 0, newReview: 0, returning: 0, continuing: 0 };
      staff[sk].total++;
      bump_(staff[sk], v);
    });

    const monthRows = Object.keys(months).sort().map(function (k) {
      const m = months[k];
      return {
        month: m.month,
        total: m.total,
        patients: Object.keys(m.patientSet).length,
        newConfirmed: m.newConfirmed,
        newReview: m.newReview,
        returning: m.returning,
        continuing: m.continuing,
      };
    });
    const staffRows = Object.keys(staff).sort().map(function (k) {
      const s = staff[k];
      return { month: s.month, staff: s.staff, total: s.total, newConfirmed: s.newConfirmed, newReview: s.newReview, returning: s.returning };
    });
    return { months: monthRows, staff: staffRows };
  }

  function bump_(acc, v) {
    if (v.category === CATEGORY.NEW) {
      if (v.needsReview) acc.newReview++; else acc.newConfirmed++;
    } else if (v.category === CATEGORY.RETURNING) {
      acc.returning++;
    } else {
      acc.continuing++;
    }
  }

  return {
    CATEGORY: CATEGORY,
    normalizeDate: normalizeDate,
    normalizePatientId: normalizePatientId,
    classify: classify,
    summarizeMonthly: summarizeMonthly,
  };
})();
