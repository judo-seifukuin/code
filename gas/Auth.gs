/**
 * LINE IDトークン検証モジュール。
 * 公式エンドポイント https://api.line.me/oauth2/v2.1/verify を利用して
 * トークンの真正性と audience (channel ID) の一致を確認する。
 */

var Auth_ = (function () {
  function verifyAndGetUserId(idToken) {
    if (!idToken) throw new Error("idToken is required");

    const channelId = PropertiesService.getScriptProperties().getProperty("LINE_CHANNEL_ID");
    if (!channelId) throw new Error("LINE_CHANNEL_ID script property is not set");

    const res = UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "post",
      contentType: "application/x-www-form-urlencoded",
      payload: {
        id_token: idToken,
        client_id: channelId,
      },
      muteHttpExceptions: true,
    });

    const code = res.getResponseCode();
    const body = JSON.parse(res.getContentText());
    if (code !== 200) {
      throw new Error("IDトークン検証失敗: " + (body.error_description || body.error || code));
    }
    if (!body.sub) throw new Error("IDトークンにユーザーIDが含まれていません");
    if (body.aud !== channelId) throw new Error("audienceが一致しません");

    return body.sub; // LINE userId
  }

  return { verifyAndGetUserId: verifyAndGetUserId };
})();
