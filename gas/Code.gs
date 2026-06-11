/**
 * LIFFアプリからのリクエストを受け付けるWebAppエンドポイント。
 * POST: { action: "save" | "history", idToken, ... }
 * 認証は LINE IDトークンの検証で行い、LINEユーザーIDをキーとしてデータを扱う。
 */

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action;
    if (!action) return jsonResponse({ ok: false, error: "action is required" });

    const userId = Auth_.verifyAndGetUserId(payload.idToken);

    switch (action) {
      case "save":
        return jsonResponse(Store_.saveRecord(userId, payload));
      case "history":
        return jsonResponse(Store_.getHistory(userId));
      case "stats":
        return jsonResponse(Store_.getStats(userId));
      default:
        return jsonResponse({ ok: false, error: "unknown action: " + action });
    }
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: String(err.message || err) });
  }
}

function doGet() {
  return jsonResponse({ ok: true, service: "AI Pose Analyzer", version: "0.1.0" });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
