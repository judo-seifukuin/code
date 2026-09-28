/**
 * 来院区分の判定ロジック（GAS API に依存しない純粋関数のみ）。
 *
 * 入力は Reader / GridReader が作る正規化済みレコード:
 *   { clinic, date, patientId, name, staff, menu, note, status }
 *
 * 区分:
 *   - 新患:               その患者の最初の来院
 *   - お久しぶり:         前回来院から thresholdDays 日以上空いた来院
 *   - 継続:               それ以外
 *   - 新患（番号未発行）: 仮番号（990 等）での来院。番号で追跡できないため別枠
 *
 * 患者の同一性は「院＋診察券番号」で判定する（sharedIds=true なら番号のみ）。
 * 院ごとのデータ開始日（最古の来院日）から thresholdDays 日以内に初登場した患者は、
 * それ以前から通っていた可能性を否定できないため needsReview = true とする。
 *
 * Node からも vm で読み込んでテストできるよう、GAS のグローバル（SpreadsheetApp 等）は使わない。
 */

var Classifier_ = (function () {
  const CATEGORY = { NEW: "新患", RETURNING: "お久しぶり", CONTINUING: "継続", UNREGISTERED: "新患（番号未発行）" };
  const ALL_CLINICS = "全院";
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const SEP = "\u0000";

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

  function cmp_(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /**
   * @param {Array<Object>} records 正規化済みレコード
   * @param {{thresholdDays?: number, cancelWords?: string[], tempIds?: string[], sharedIds?: boolean}} options
   * @return {{visits: Array<Object>, excluded: Object, dataStart: string, dataEnd: string}}
   */
  function classify(records, options) {
    const opts = options || {};
    const threshold = Number(opts.thresholdDays) > 0 ? Number(opts.thresholdDays) : 90;
    const cancelWords = (opts.cancelWords || []).map(function (w) { return String(w).trim(); });
    const tempIds = (opts.tempIds || []).map(normalizePatientId).filter(String);
    const sharedIds = !!opts.sharedIds;
    const excluded = { cancelled: 0, noPatientId: 0, invalidDate: 0 };

    // 1. 除外 + 同日重複の集約（患者×日付で1来院）
    const byKey = {};
    records.forEach(function (r) {
      if (isCancelled_(r.status, cancelWords)) { excluded.cancelled++; return; }
      const id = normalizePatientId(r.patientId);
      if (!id) { excluded.noPatientId++; return; }
      const date = normalizeDate(r.date);
      if (!date) { excluded.invalidDate++; return; }
      const clinic = String(r.clinic || "").trim();
      const temp = tempIds.indexOf(id) !== -1;
      // 仮番号は番号で人を区別できないので、備考（無ければ担当＋時刻）で同日の枠をまとめる
      const tempLabel = String(r.note || "").trim() || String(r.staff || "") + "@" + String(r.time || "");
      const patientKey = temp ? "" : (sharedIds ? id : clinic + SEP + id);
      const key = temp ? ["temp", clinic, date, tempLabel].join(SEP) : patientKey + SEP + date;
      if (!byKey[key]) {
        byKey[key] = { clinic: clinic, patientId: id, patientKey: patientKey, temp: temp, date: date, names: [], staffs: [], menus: [], notes: [] };
      }
      const v = byKey[key];
      v.names.push(r.name);
      v.staffs.push(r.staff);
      v.menus.push(r.menu);
      v.notes.push(r.note);
      // 番号共通モードで複数院に来た同日来院は院名を結合
      if (clinic && v.clinic.split("・").indexOf(clinic) === -1) v.clinic += "・" + clinic;
    });

    const merged = Object.keys(byKey).map(function (k) {
      const v = byKey[k];
      return {
        clinic: v.clinic,
        patientId: v.patientId,
        patientKey: v.patientKey,
        temp: v.temp,
        date: v.date,
        name: joinDistinct_(v.names),
        staff: joinDistinct_(v.staffs),
        menu: joinDistinct_(v.menus),
        note: joinDistinct_(v.notes),
      };
    });
    if (!merged.length) return { visits: [], excluded: excluded, dataStart: "", dataEnd: "" };

    merged.sort(function (a, b) {
      return cmp_(a.date, b.date) || cmp_(a.clinic, b.clinic) || cmp_(a.patientId, b.patientId) || cmp_(a.note, b.note);
    });
    const dataStart = merged[0].date;
    const dataEnd = merged[merged.length - 1].date;

    // 「要確認」の基準となるデータ開始日（院ごと。番号共通モードでは全体）
    const startDayOf = {};
    merged.forEach(function (v) {
      const scope = sharedIds ? ALL_CLINICS : v.clinic;
      if (startDayOf[scope] === undefined) startDayOf[scope] = dayNumber_(v.date);
    });

    // 2. 日付昇順に走査し、患者ごとの前回来院日と比較
    const lastVisit = {};
    const visits = merged.map(function (v) {
      const day = dayNumber_(v.date);
      let category, gapDays = null, prevDate = "", needsReview = false;
      if (v.temp) {
        category = CATEGORY.UNREGISTERED;
      } else {
        const prev = lastVisit[v.patientKey];
        if (!prev) {
          category = CATEGORY.NEW;
          needsReview = day - startDayOf[sharedIds ? ALL_CLINICS : v.clinic] < threshold;
        } else {
          gapDays = day - prev.day;
          prevDate = prev.date;
          category = gapDays >= threshold ? CATEGORY.RETURNING : CATEGORY.CONTINUING;
        }
        lastVisit[v.patientKey] = { day: day, date: v.date };
      }
      return {
        clinic: v.clinic,
        date: v.date,
        patientId: v.patientId,
        patientKey: v.temp ? "temp" + SEP + v.clinic + SEP + v.date + SEP + v.note : v.patientKey,
        name: v.name,
        staff: v.staff,
        menu: v.menu,
        note: v.note,
        category: category,
        prevDate: prevDate,
        gapDays: gapDays,
        needsReview: needsReview,
      };
    });

    return { visits: visits, excluded: excluded, dataStart: dataStart, dataEnd: dataEnd };
  }

  function emptyCounts_() {
    return { total: 0, patientSet: {}, newConfirmed: 0, newReview: 0, newUnregistered: 0, returning: 0, continuing: 0 };
  }

  function bump_(acc, v) {
    acc.total++;
    acc.patientSet[v.patientKey] = true;
    if (v.category === CATEGORY.NEW) {
      if (v.needsReview) acc.newReview++; else acc.newConfirmed++;
    } else if (v.category === CATEGORY.UNREGISTERED) {
      acc.newUnregistered++;
    } else if (v.category === CATEGORY.RETURNING) {
      acc.returning++;
    } else {
      acc.continuing++;
    }
  }

  function finish_(acc, extra) {
    const row = {};
    Object.keys(extra).forEach(function (k) { row[k] = extra[k]; });
    row.total = acc.total;
    row.patients = Object.keys(acc.patientSet).length;
    row.newConfirmed = acc.newConfirmed;
    row.newReview = acc.newReview;
    row.newUnregistered = acc.newUnregistered;
    row.returning = acc.returning;
    row.continuing = acc.continuing;
    return row;
  }

  // 「全院」を先頭に、以降は院名順
  function clinicOrder_(a, b) {
    if (a === b) return 0;
    if (a === ALL_CLINICS) return -1;
    if (b === ALL_CLINICS) return 1;
    return cmp_(a, b);
  }

  /**
   * 月次集計（院別＋全院合計）。院が1つしかない場合は全院行を作らない。
   * @return {{months: Array<Object>, staff: Array<Object>}}
   *   months: { clinic, month, total, patients, newConfirmed, newReview, newUnregistered, returning, continuing }
   *   staff:  { clinic, month, staff, total, patients, newConfirmed, newReview, newUnregistered, returning, continuing }
   */
  function summarizeMonthly(visits) {
    const clinics = {};
    visits.forEach(function (v) { clinics[v.clinic] = true; });
    const withTotal = Object.keys(clinics).length > 1;

    const months = {};
    const staff = {};
    visits.forEach(function (v) {
      const month = v.date.slice(0, 7);
      const scopes = withTotal ? [v.clinic, ALL_CLINICS] : [v.clinic];
      scopes.forEach(function (clinic) {
        const mk = clinic + SEP + month;
        if (!months[mk]) months[mk] = { clinic: clinic, month: month, acc: emptyCounts_() };
        bump_(months[mk].acc, v);
      });

      const staffName = v.staff || "（未設定）";
      const sk = v.clinic + SEP + month + SEP + staffName;
      if (!staff[sk]) staff[sk] = { clinic: v.clinic, month: month, staff: staffName, acc: emptyCounts_() };
      bump_(staff[sk].acc, v);
    });

    const monthRows = Object.keys(months)
      .map(function (k) { return months[k]; })
      .sort(function (a, b) { return clinicOrder_(a.clinic, b.clinic) || cmp_(a.month, b.month); })
      .map(function (m) { return finish_(m.acc, { clinic: m.clinic, month: m.month }); });
    const staffRows = Object.keys(staff)
      .map(function (k) { return staff[k]; })
      .sort(function (a, b) { return cmp_(a.clinic, b.clinic) || cmp_(a.month, b.month) || cmp_(a.staff, b.staff); })
      .map(function (s) { return finish_(s.acc, { clinic: s.clinic, month: s.month, staff: s.staff }); });
    return { months: monthRows, staff: staffRows };
  }

  return {
    CATEGORY: CATEGORY,
    ALL_CLINICS: ALL_CLINICS,
    normalizeDate: normalizeDate,
    normalizePatientId: normalizePatientId,
    classify: classify,
    summarizeMonthly: summarizeMonthly,
  };
})();
