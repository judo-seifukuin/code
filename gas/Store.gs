/**
 * スプレッドシート保存・履歴取得モジュール。
 *
 * 保存内容（最小限・PII無し）:
 *   - createdAt: サーバ時刻
 *   - clientAt:  端末側の撮影時刻
 *   - userId:    LINEユーザーID（無機質な英数字。実名等は持たない）
 *   - score:     総合スコア
 *   - metrics:   各指標のJSON
 *   - landmarks: 33点のランドマーク座標JSON
 *   - imageUrl:  Driveに保存した骨格サムネイル（生画像ではない）のファイルID
 *
 * 画像は Drive の専用フォルダ（非公開）に PNG として保存する。
 * 共有設定は変更しないため、デプロイユーザー本人のみアクセス可能となる。
 */

var Store_ = (function () {
  const SHEET_NAME = "records";
  const HEADERS = ["createdAt", "clientAt", "userId", "score", "metrics", "landmarks", "imageFileId"];

  function getSheet_() {
    const sheetId = PropertiesService.getScriptProperties().getProperty("SHEET_ID");
    if (!sheetId) throw new Error("SHEET_ID script property is not set");
    const ss = SpreadsheetApp.openById(sheetId);
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
      sheet.setFrozenRows(1);
    }
    return sheet;
  }

  function getImageFolder_() {
    const folderId = PropertiesService.getScriptProperties().getProperty("DRIVE_FOLDER_ID");
    if (!folderId) return null; // フォルダ未設定なら画像保存はスキップ
    return DriveApp.getFolderById(folderId);
  }

  function saveSkeletonImage_(userId, dataUrl) {
    if (!dataUrl) return "";
    const folder = getImageFolder_();
    if (!folder) return "";
    const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
    if (!match) return "";
    const bytes = Utilities.base64Decode(match[2]);
    const blob = Utilities.newBlob(bytes, match[1], `${userId}_${Date.now()}.png`);
    const file = folder.createFile(blob);
    return file.getId();
  }

  function saveRecord(userId, payload) {
    const sheet = getSheet_();
    const imageFileId = saveSkeletonImage_(userId, payload.skeleton);
    const row = [
      new Date(),
      payload.clientAt || "",
      userId,
      Number(payload.score) || 0,
      JSON.stringify(payload.metrics || []),
      JSON.stringify(payload.landmarks || []),
      imageFileId,
    ];
    sheet.appendRow(row);
    return { ok: true, imageFileId: imageFileId };
  }

  function getHistory(userId) {
    const sheet = getSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { ok: true, records: [] };

    const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
    const records = values
      .filter((r) => r[2] === userId)
      .map((r) => ({
        at: r[0] instanceof Date ? r[0].toISOString() : String(r[0]),
        clientAt: r[1] ? (r[1] instanceof Date ? r[1].toISOString() : String(r[1])) : "",
        score: Number(r[3]) || 0,
        metrics: safeParse_(r[4], []),
        landmarks: safeParse_(r[5], []),
        imageFileId: r[6] || "",
      }))
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, 20);

    return { ok: true, records: records };
  }

  // 統計集計: ユーザー個人 + 院内全体の平均スコア・回数・前回スコアを返す
  function getStats(userId) {
    const sheet = getSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return {
        ok: true,
        user: { count: 0, average: null, lastScore: null, lastAt: null },
        clinic: { count: 0, average: null },
      };
    }
    const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
    const allScores = [];
    const mine = [];
    values.forEach((r) => {
      const sc = Number(r[3]);
      if (!isFinite(sc)) return;
      allScores.push(sc);
      if (r[2] === userId) {
        mine.push({ at: r[0], score: sc });
      }
    });
    mine.sort((a, b) => (a.at < b.at ? 1 : -1)); // 新しい順

    const avg = (arr) => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;

    return {
      ok: true,
      user: {
        count: mine.length,
        average: avg(mine.map((m) => m.score)),
        lastScore: mine.length ? mine[0].score : null,
        lastAt: mine.length ? (mine[0].at instanceof Date ? mine[0].at.toISOString() : String(mine[0].at)) : null,
      },
      clinic: {
        count: allScores.length,
        average: avg(allScores),
      },
    };
  }

  function safeParse_(s, fallback) {
    try { return JSON.parse(s); } catch (e) { return fallback; }
  }

  return {
    saveRecord: saveRecord,
    getHistory: getHistory,
    getStats: getStats,
  };
})();
