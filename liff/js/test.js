// テストモード用スクリプト。LIFF/GAS を介さず PoseAnalyzer の動作確認だけを行う。
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const VIEWS = ["view-start", "view-capture", "view-result"];
  const state = { stream: null };

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
    const el = $("status");
    el.textContent = message || "";
    el.classList.toggle("error", !!isError);
  }

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

  function labelOfView(view) {
    return { frontal: "正面", left_side: "左側面", right_side: "右側面", oblique: "斜め", unknown: "判定不能" }[view] || view;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  async function analyzeSource(source, sourceWidth, sourceHeight) {
    showLoading("解析中...");
    try {
      const results = await PoseAnalyzer.analyze(source);
      const landmarks = results.poseLandmarks;
      const evalResult = PoseAnalyzer.evaluate(landmarks);

      // 原画 + 注釈オーバーレイ
      const W = 360, H = 480;
      const annotated = PoseAnalyzer.renderAnnotated(landmarks, source, W, H, { plumbLine: true, labels: true });
      const result = $("result-canvas");
      result.width = W; result.height = H;
      result.getContext("2d").drawImage(annotated, 0, 0);

      // メタ
      const meta = $("result-meta");
      meta.innerHTML = "";
      const q = evalResult.quality;
      meta.innerHTML = `
        <span class="chip">アングル: <strong>${labelOfView(q.view)}</strong></span>
        <span class="chip">全身可視: <strong>${q.fullBody ? "✓" : "✗"}</strong></span>
        <span class="chip">立位判定: <strong>${q.standing ? "✓" : "✗"}</strong></span>
      `;

      // 警告
      const warn = $("quality-warning");
      if (q.warnings.length) {
        warn.classList.remove("hidden");
        warn.classList.toggle("danger", !q.canScore);
        warn.innerHTML = `<strong>${q.canScore ? "注意" : "評価不可"}</strong><ul>${q.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`;
      } else {
        warn.classList.add("hidden");
      }

      // スコア
      if (q.canScore && evalResult.score != null) {
        $("score-value").textContent = evalResult.score;
        $("score-sub").textContent = "コア4指標（肩・骨盤・頭部偏位・体幹）の重症度合算";
      } else {
        $("score-value").textContent = "—";
        $("score-sub").textContent = "撮影品質要件を満たしていないため、スコアは算出していません。";
      }

      // 計測値テーブル
      const table = $("metrics-table");
      table.innerHTML = "";
      evalResult.metrics.forEach((m) => table.appendChild(renderMetricRow(m)));

      // パターン
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

      // デバッグ情報
      $("debug-info").textContent = JSON.stringify({
        sourceSize: `${sourceWidth} x ${sourceHeight}`,
        quality: q,
        score: evalResult.score,
        metrics: evalResult.metrics,
        patterns: evalResult.patterns,
      }, null, 2);

      setStatus("");
      stopCamera();
      showView("view-result");
    } catch (e) {
      console.error(e);
      setStatus(e.message || "解析に失敗しました。", true);
    } finally {
      hideLoading();
    }
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

  async function shootFromCamera() {
    const video = $("video");
    if (!video.videoWidth) {
      setStatus("カメラの準備ができていません。", true);
      return;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    tmp.getContext("2d").drawImage(video, 0, 0, w, h);
    await analyzeSource(tmp, w, h);
  }

  function loadUploaded(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => analyzeSource(img, img.width, img.height);
      img.onerror = () => setStatus("画像の読み込みに失敗しました。", true);
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // サンプル画像をロード。Geminiの透かしを右下から白で覆い隠してから解析・表示する。
  function loadSample(src) {
    showLoading("サンプル画像を読み込み中...");
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      // 右下のGemini透かし領域を白でマスク（おおよそ右12% × 下7%）
      const maskW = img.width * 0.14;
      const maskH = img.height * 0.08;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(img.width - maskW, img.height - maskH, maskW, maskH);
      analyzeSource(canvas, img.width, img.height);
    };
    img.onerror = () => {
      setStatus("サンプル画像の読み込みに失敗しました。", true);
      hideLoading();
    };
    img.src = src;
  }

  function bindEvents() {
    $("btn-camera").addEventListener("click", async () => {
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
    $("btn-upload").addEventListener("click", () => $("file-input").click());
    $("file-input").addEventListener("change", (e) => loadUploaded(e.target.files[0]));
    document.querySelectorAll(".sample-item").forEach((item) => {
      item.addEventListener("click", () => loadSample(item.dataset.src));
    });
    $("btn-shoot").addEventListener("click", shootFromCamera);
    $("btn-cancel").addEventListener("click", () => {
      stopCamera();
      setStatus("");
      showView("view-start");
    });
    $("btn-retake").addEventListener("click", () => {
      setStatus("");
      showView("view-start");
    });
  }

  document.addEventListener("DOMContentLoaded", bindEvents);
})();
