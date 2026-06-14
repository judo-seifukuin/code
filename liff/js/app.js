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
    lastOriginalCanvas: null,
    lastLandmarks: null,
    lastEvalResult: null,
    layers: { idealLines: false, arrows: false, partPlumbLines: false, heatmap: false, futureGhost: false },
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
      const w = video.videoWidth;
      const h = video.videoHeight;
      const tmp = document.createElement("canvas");
      tmp.width = w;
      tmp.height = h;
      tmp.getContext("2d").drawImage(video, 0, 0, w, h);

      const results = await PoseAnalyzer.analyze(tmp);
      const landmarks = results.poseLandmarks;
      const evalResult = PoseAnalyzer.evaluate(landmarks);

      // 結果画面に原画+注釈オーバーレイを描画
      renderResult(landmarks, evalResult, tmp);

      // 保存用サムネ（骨格のみ・原画含まず）はクオリティOKの時だけ作る
      let skeletonB64 = null;
      if (evalResult.quality.canScore) {
        const skeleton = PoseAnalyzer.renderSkeleton(landmarks, 360, 480);
        skeletonB64 = skeleton.toDataURL("image/png");
      }

      state.lastAnalysis = evalResult.quality.canScore ? {
        score: evalResult.score,
        metrics: evalResult.metrics,
        patterns: evalResult.patterns,
        quality: evalResult.quality,
        landmarks: PoseAnalyzer.serializeLandmarks(landmarks),
        skeletonB64,
      } : null;

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

  // ---- 結果レンダラ ----
  function renderResult(landmarks, evalResult, originalCanvas) {
    state.lastOriginalCanvas = originalCanvas;
    state.lastLandmarks = landmarks;
    state.lastEvalResult = evalResult;
    redrawCanvas();

    const q = evalResult.quality;

    // メタ（撮影アングル / 全身 / 立位）
    const meta = $("result-meta");
    meta.innerHTML = "";
    meta.appendChild(makeChip("撮影アングル", labelOfView(q.view)));
    meta.appendChild(makeChip("全身可視", q.fullBody ? "✓" : "✗"));
    meta.appendChild(makeChip("立位判定", q.standing ? "✓" : "✗"));

    // 警告表示
    const warnEl = $("quality-warning");
    if (q.warnings.length) {
      warnEl.classList.remove("hidden");
      warnEl.classList.toggle("danger", !q.canScore);
      warnEl.innerHTML = `<strong>${q.canScore ? "注意" : "評価不可"}</strong><ul>${q.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`;
    } else {
      warnEl.classList.add("hidden");
    }

    // 段①: 結論ブロック
    renderConclusion(evalResult, null);
    // 段②: 今日のひとこと
    renderTakeaway(evalResult);

    if (q.canScore && evalResult.score != null) {
      $("btn-save").disabled = false;
      fetchAndRenderStats(evalResult); // 非同期で stats 取得して上書き
    } else {
      $("btn-save").disabled = true;
    }

    // 計測値テーブル
    const table = $("metrics-table");
    table.innerHTML = "";
    if (evalResult.metrics.length) {
      evalResult.metrics.forEach((m) => table.appendChild(renderMetricRow(m)));
    } else {
      table.innerHTML = '<p class="patterns-list empty">計測値はありません。</p>';
    }

    // 検出パターン
    const pList = $("patterns-list");
    pList.innerHTML = "";
    if (evalResult.patterns && evalResult.patterns.length) {
      evalResult.patterns.forEach((p) => {
        const div = document.createElement("div");
        div.className = "pattern-item";
        div.textContent = p;
        pList.appendChild(div);
      });
    } else if (q.canScore) {
      pList.innerHTML = '<p class="empty">特筆すべき左右差・偏位は検出されませんでした。</p>';
    } else {
      pList.innerHTML = '<p class="empty">評価対象外のため、パターン判定は行っていません。</p>';
    }

    $("kendall-note").textContent = evalResult.kendallNote || "";
  }

  // 段①: 結論ブロック（スコア+ステータス+一言サマリ+チップ）
  function renderConclusion(evalResult, stats) {
    const conc = $("conclusion");
    conc.classList.remove("good", "fair", "warn", "alert", "unavailable");
    const status = evalResult.status || { icon: "—", label: "—", klass: "unavailable" };
    conc.classList.add(status.klass);
    if (evalResult.quality.canScore && evalResult.score != null) {
      $("score-value").textContent = evalResult.score;
      $("score-status").textContent = `${status.icon} ${status.label}`;
      $("score-summary").textContent = evalResult.summaryLabel || "";
      $("score-summary").style.display = "";
    } else {
      $("score-value").textContent = "—";
      $("score-status").textContent = "評価不可";
      $("score-summary").textContent = "撮影品質要件を満たしていません";
      $("score-summary").style.display = "";
    }
    renderConclusionStats(evalResult, stats);
  }

  function renderConclusionStats(evalResult, stats) {
    const el = $("score-stats");
    el.innerHTML = "";
    if (!evalResult.quality.canScore) return;
    const target = evalResult.targetScore || 85;
    addStatChip(el, "目標", `${target}点以上`, "target");
    if (stats && stats.user) {
      if (stats.user.average != null) {
        addStatChip(el, "あなたの平均", `${stats.user.average}点 (${stats.user.count}回)`);
      }
      if (stats.user.lastScore != null && evalResult.score != null) {
        const diff = evalResult.score - stats.user.lastScore;
        const sign = diff > 0 ? "+" : "";
        const klass = diff > 0 ? "diff-up" : diff < 0 ? "diff-down" : "";
        addStatChip(el, "前回比", `${sign}${diff}点`, klass);
      }
    }
    if (stats && stats.clinic && stats.clinic.average != null) {
      addStatChip(el, "院内平均", `${stats.clinic.average}点 (${stats.clinic.count}件)`);
    }
  }
  function addStatChip(parent, label, value, klass) {
    const span = document.createElement("span");
    span.className = "stat-chip" + (klass ? " " + klass : "");
    span.innerHTML = `${escapeHtml(label)}: <strong>${escapeHtml(value)}</strong>`;
    parent.appendChild(span);
  }
  async function fetchAndRenderStats(evalResult) {
    try {
      const data = await callGas({ action: "stats", idToken: state.idToken });
      renderConclusion(evalResult, data);
    } catch (e) {
      console.warn("stats取得失敗", e);
    }
  }

  // 段②: 今日のひとこと
  function renderTakeaway(evalResult) {
    const t = evalResult.takeaway;
    const takeawayBox = $("takeaway");
    if (!t || !evalResult.quality.canScore) {
      takeawayBox.style.display = "none";
      return;
    }
    takeawayBox.style.display = "";
    $("takeaway-body").innerHTML = `${escapeHtml(t.observation)}<br><span style="color:var(--text-sub);font-size:12px;">${escapeHtml(t.cause)}</span>`;
    $("takeaway-action").textContent = "→ " + t.action;
  }

  // 骨格画像（段③内）の再描画。レイヤートグルが変わったときに呼ぶ。
  function redrawCanvas() {
    if (!state.lastLandmarks) return;
    const W = 360, H = 480;
    const canvas = $("result-canvas");
    canvas.width = W;
    canvas.height = H;
    const opts = {
      plumbLine: true,
      labels: true,
      idealLines: state.layers.idealLines,
      arrows: state.layers.arrows,
      partPlumbLines: state.layers.partPlumbLines,
      heatmap: state.layers.heatmap,
      futureGhost: state.layers.futureGhost ? 1.6 : false,
    };
    const annotated = PoseAnalyzer.renderAnnotated(
      state.lastLandmarks, state.lastOriginalCanvas, W, H, opts, state.lastEvalResult
    );
    canvas.getContext("2d").drawImage(annotated, 0, 0);
  }

  function renderMetricRow(m) {
    const div = document.createElement("div");
    div.className = "metric-row";
    const sign = m.valueDeg > 0 ? "+" : "";
    const [lo, hi] = m.normalRangeDeg;
    div.innerHTML = `
      <div class="name">${escapeHtml(m.label)}<small>${escapeHtml(m.clinicalName)}</small></div>
      <div class="value">${sign}${m.valueDeg}°<small>正常域 ${lo}°〜${hi}°</small></div>
      <div class="badge badge-${m.severity}">${escapeHtml(m.severityLabel)}</div>
      <div class="explanation">${escapeHtml(m.direction)} ／ ${escapeHtml(m.explanation)}</div>
    `;
    return div;
  }

  function makeChip(key, value) {
    const span = document.createElement("span");
    span.className = "chip";
    span.innerHTML = `${escapeHtml(key)}: <strong>${escapeHtml(value)}</strong>`;
    return span;
  }

  function labelOfView(view) {
    return { frontal: "正面", left_side: "左側面", right_side: "右側面", oblique: "斜め", unknown: "判定不能" }[view] || view;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
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
    if (!state.lastAnalysis) {
      setStatus("評価対象外の撮影は保存できません。撮り直してください。", true);
      return;
    }
    showLoading("保存中...");
    try {
      const a = state.lastAnalysis;
      await callGas({
        action: "save",
        idToken: state.idToken,
        score: a.score,
        metrics: a.metrics,
        patterns: a.patterns,
        quality: { view: a.quality.view, standing: a.quality.standing, fullBody: a.quality.fullBody },
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
    // レイヤートグル
    document.querySelectorAll("#layer-controls input[data-layer]").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        state.layers[e.target.dataset.layer] = e.target.checked;
        redrawCanvas();
      });
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
