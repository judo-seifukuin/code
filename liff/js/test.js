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

  async function analyzeSource(source, sourceWidth, sourceHeight) {
    showLoading("解析中...");
    try {
      const results = await PoseAnalyzer.analyze(source);
      const landmarks = results.poseLandmarks;
      const evalResult = PoseAnalyzer.evaluate(landmarks);

      const skeleton = PoseAnalyzer.renderSkeleton(landmarks, 360, 480);
      const result = $("result-canvas");
      result.width = skeleton.width;
      result.height = skeleton.height;
      result.getContext("2d").drawImage(skeleton, 0, 0);

      $("score-value").textContent = evalResult.score;
      const metricsEl = $("metrics");
      metricsEl.innerHTML = "";
      evalResult.metrics.forEach((m) => {
        const li = document.createElement("li");
        li.innerHTML = `<span>${m.label}</span><span>${m.value} / 25 <small style="color:var(--text-sub)">(raw ${m.raw.toFixed(3)})</small></span>`;
        metricsEl.appendChild(li);
      });

      $("debug-info").textContent = JSON.stringify({
        score: evalResult.score,
        sourceSize: `${sourceWidth} x ${sourceHeight}`,
        metrics: evalResult.metrics,
        landmarkCount: landmarks.length,
        sampleLandmarks: {
          nose: landmarks[0],
          leftShoulder: landmarks[11],
          rightShoulder: landmarks[12],
          leftHip: landmarks[23],
          rightHip: landmarks[24],
        },
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

  // MediaPipe の公式サンプル画像（CDN ホスト）を流用してネット越しに動作確認
  function loadSample() {
    showLoading("サンプル画像を読み込み中...");
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => analyzeSource(img, img.width, img.height);
    img.onerror = () => {
      setStatus("サンプル画像の読み込みに失敗しました。ネットワークを確認してください。", true);
      hideLoading();
    };
    img.src = "https://storage.googleapis.com/mediapipe-assets/pose_world_landmarks.jpg";
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
    $("btn-sample").addEventListener("click", loadSample);
    $("btn-upload").addEventListener("click", () => $("file-input").click());
    $("file-input").addEventListener("change", (e) => loadUploaded(e.target.files[0]));
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
