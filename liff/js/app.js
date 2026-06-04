// LIFFアプリのメイン制御。画面遷移・カメラ・GAS通信を扱う。
(function () {
  "use strict";

  const cfg = window.APP_CONFIG;
  const $ = (id) => document.getElementById(id);

  const state = {
    idToken: null,
    userId: null,
    stream: null,
    lastAnalysis: null, // { score, metrics, landmarks, skeletonB64 }
  };

  // ---- 画面遷移 ----
  const VIEWS = ["view-consent", "view-capture", "view-result", "view-history", "view-compare"];
  function showView(id) {
    VIEWS.forEach((v) => $(v).classList.toggle("hidden", v !== id));
  }
  function showLoading(text) {
    $("loading-text").textContent = text || "処理中...";
    $("loading").classList.remove("hidden");
  }
  function hideLoading() {
    $("loading").classList.add("hidden");
  }
  function setStatus(message, isError) {
    const el = $("save-status");
    el.textContent = message || "";
    el.classList.toggle("error", !!isError);
  }

  // ---- LIFF 初期化 ----
  async function initLiff() {
    if (cfg.DEV_MODE) {
      state.userId = "DEV_USER";
      state.idToken = "DEV_TOKEN";
      return;
    }
    await liff.init({ liffId: cfg.LIFF_ID });
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }
    state.idToken = liff.getIDToken();
    const profile = await liff.getProfile();
    state.userId = profile.userId;
  }

  // ---- カメラ ----
  async function startCamera() {
    stopCamera();
    const video = $("video");
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = state.stream;
    await video.play();
  }
  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
  }

  // ---- 撮影 & 解析 ----
  async function shoot() {
    const video = $("video");
    if (!video.videoWidth) {
      setStatus("カメラの準備ができていません。", true);
      return;
    }
    showLoading("解析中...");
    try {
      // ① 一時キャンバスに現フレームを描画（解析のみに利用、保存しない）
      const w = video.videoWidth;
      const h = video.videoHeight;
      const tmp = document.createElement("canvas");
      tmp.width = w;
      tmp.height = h;
      tmp.getContext("2d").drawImage(video, 0, 0, w, h);

      // ② MediaPipe で姿勢解析
      const results = await PoseAnalyzer.analyze(tmp);
      const landmarks = results.poseLandmarks;
      const evalResult = PoseAnalyzer.evaluate(landmarks);

      // ③ 骨格のみのサムネイル生成（生画像は破棄）
      const skeleton = PoseAnalyzer.renderSkeleton(landmarks, 360, 480);
      const skeletonB64 = skeleton.toDataURL("image/png");

      // ④ 結果画面に描画
      const result = $("result-canvas");
      result.width = skeleton.width;
      result.height = skeleton.height;
      result.getContext("2d").drawImage(skeleton, 0, 0);

      $("score-value").textContent = evalResult.score;
      const metricsEl = $("metrics");
      metricsEl.innerHTML = "";
      evalResult.metrics.forEach((m) => {
        const li = document.createElement("li");
        li.innerHTML = `<span>${m.label}</span><span>${m.value} / 25</span>`;
        metricsEl.appendChild(li);
      });

      state.lastAnalysis = {
        score: evalResult.score,
        metrics: evalResult.metrics,
        landmarks: PoseAnalyzer.serializeLandmarks(landmarks),
        skeletonB64,
      };

      stopCamera();
      setStatus("");
      showView("view-result");
    } catch (e) {
      console.error(e);
      setStatus(e.message || "解析に失敗しました。", true);
    } finally {
      hideLoading();
    }
  }

  // ---- GAS 通信 ----
  async function callGas(payload) {
    const res = await fetch(cfg.GAS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // GAS doPost で受けやすい形
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`通信エラー (HTTP ${res.status})`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "サーバーエラー");
    return data;
  }

  async function saveRecord() {
    if (!state.lastAnalysis) return;
    showLoading("保存中...");
    try {
      const a = state.lastAnalysis;
      await callGas({
        action: "save",
        idToken: state.idToken,
        score: a.score,
        metrics: a.metrics,
        landmarks: a.landmarks,
        skeleton: a.skeletonB64,
        clientAt: new Date().toISOString(),
      });
      setStatus("保存しました。");
    } catch (e) {
      console.error(e);
      setStatus(e.message, true);
    } finally {
      hideLoading();
    }
  }

  async function loadHistory() {
    showLoading("履歴を取得中...");
    try {
      const data = await callGas({
        action: "history",
        idToken: state.idToken,
      });
      renderHistory(data.records || []);
      showView("view-history");
    } catch (e) {
      console.error(e);
      setStatus(e.message, true);
    } finally {
      hideLoading();
    }
  }

  function renderHistory(records) {
    const list = $("history-list");
    list.innerHTML = "";
    if (!records.length) {
      list.innerHTML = '<p class="status">履歴はまだありません。</p>';
      return;
    }
    const canCompare = !!state.lastAnalysis;
    records.forEach((r) => {
      const item = document.createElement("div");
      item.className = "history-item" + (canCompare && r.landmarks && r.landmarks.length ? " tappable" : "");
      const date = new Date(r.at).toLocaleString("ja-JP", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
      item.innerHTML = `
        <div class="date">${date}</div>
        <div class="score">${r.score}</div>
      `;
      if (canCompare && r.landmarks && r.landmarks.length) {
        item.addEventListener("click", () => openCompare(r));
      }
      list.appendChild(item);
    });
    if (!canCompare) {
      const note = document.createElement("p");
      note.className = "status";
      note.textContent = "比較するには、先に撮影して結果を表示してください。";
      list.appendChild(note);
    }
  }

  function openCompare(beforeRecord) {
    if (!state.lastAnalysis) return;
    const W = 240;
    const H = 320;

    const beforeCanvas = $("compare-before-canvas");
    beforeCanvas.width = W;
    beforeCanvas.height = H;
    const beforeSkel = PoseAnalyzer.renderSkeleton(beforeRecord.landmarks, W, H);
    beforeCanvas.getContext("2d").drawImage(beforeSkel, 0, 0);

    const afterCanvas = $("compare-after-canvas");
    afterCanvas.width = W;
    afterCanvas.height = H;
    const afterSkel = PoseAnalyzer.renderSkeleton(state.lastAnalysis.landmarks, W, H);
    afterCanvas.getContext("2d").drawImage(afterSkel, 0, 0);

    const beforeDate = new Date(beforeRecord.at).toLocaleString("ja-JP", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
    $("compare-before-label").textContent = `Before（${beforeDate}）`;
    $("compare-before-score").textContent = beforeRecord.score;
    $("compare-after-score").textContent = state.lastAnalysis.score;

    const diff = state.lastAnalysis.score - beforeRecord.score;
    const diffEl = $("compare-diff");
    diffEl.classList.remove("up", "down");
    if (diff > 0) {
      diffEl.textContent = `▲ ${diff} ポイント改善しました`;
      diffEl.classList.add("up");
    } else if (diff < 0) {
      diffEl.textContent = `▼ ${Math.abs(diff)} ポイント低下しています`;
      diffEl.classList.add("down");
    } else {
      diffEl.textContent = "前回と同じスコアです";
    }
    showView("view-compare");
  }

  // ---- イベント結線 ----
  function bindEvents() {
    $("consent-check").addEventListener("change", (e) => {
      $("btn-start").disabled = !e.target.checked;
    });
    $("btn-start").addEventListener("click", async () => {
      showLoading("カメラを起動中...");
      try {
        await startCamera();
        showView("view-capture");
      } catch (e) {
        console.error(e);
        setStatus("カメラを起動できませんでした。" + (e.message || ""), true);
      } finally {
        hideLoading();
      }
    });
    $("btn-shoot").addEventListener("click", shoot);
    $("btn-history").addEventListener("click", loadHistory);
    $("btn-save").addEventListener("click", saveRecord);
    $("btn-retake").addEventListener("click", async () => {
      state.lastAnalysis = null;
      setStatus("");
      showLoading("カメラを起動中...");
      try {
        await startCamera();
        showView("view-capture");
      } finally {
        hideLoading();
      }
    });
    $("btn-back").addEventListener("click", () => {
      showView("view-consent");
    });
    $("btn-compare-back").addEventListener("click", () => {
      showView("view-history");
    });
  }

  // ---- 起動 ----
  async function main() {
    bindEvents();
    showLoading("起動中...");
    try {
      await initLiff();
      showView("view-consent");
    } catch (e) {
      console.error(e);
      setStatus("初期化に失敗しました。" + (e.message || ""), true);
    } finally {
      hideLoading();
    }
  }

  document.addEventListener("DOMContentLoaded", main);
})();
