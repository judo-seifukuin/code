// MediaPipe Pose を用いた姿勢解析モジュール。
// すべての処理は端末内（ブラウザ）で完結し、外部に画像は送信しない。
(function (global) {
  "use strict";

  const LANDMARK = {
    NOSE: 0,
    LEFT_EAR: 7,
    RIGHT_EAR: 8,
    LEFT_SHOULDER: 11,
    RIGHT_SHOULDER: 12,
    LEFT_HIP: 23,
    RIGHT_HIP: 24,
  };

  let poseInstance = null;
  let lastResults = null;

  function ensurePose() {
    if (poseInstance) return poseInstance;
    if (typeof Pose === "undefined") {
      throw new Error("MediaPipe Pose ライブラリが読み込まれていません。");
    }
    poseInstance = new Pose({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`,
    });
    poseInstance.setOptions({
      modelComplexity: 1,
      smoothLandmarks: true,
      enableSegmentation: false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    poseInstance.onResults((results) => {
      lastResults = results;
    });
    return poseInstance;
  }

  // 画像（HTMLCanvasElement / HTMLImageElement / HTMLVideoElement）を1枚解析する
  async function analyze(source) {
    const pose = ensurePose();
    lastResults = null;
    await pose.send({ image: source });
    if (!lastResults || !lastResults.poseLandmarks) {
      throw new Error("姿勢を検出できませんでした。全身が画面に入るように撮影し直してください。");
    }
    return lastResults;
  }

  // 0〜1 のズレを 0〜25 の減点幅で評価する。tolerance を超えた分だけ減点。
  function metricScore(deviation, tolerance) {
    const over = Math.max(0, Math.abs(deviation) - tolerance);
    const ratio = Math.min(1, over / tolerance);
    return Math.round(25 * (1 - ratio));
  }

  // ランドマーク座標から姿勢スコアと内訳を算出する。
  function evaluate(landmarks) {
    const ls = landmarks[LANDMARK.LEFT_SHOULDER];
    const rs = landmarks[LANDMARK.RIGHT_SHOULDER];
    const lh = landmarks[LANDMARK.LEFT_HIP];
    const rh = landmarks[LANDMARK.RIGHT_HIP];
    const le = landmarks[LANDMARK.LEFT_EAR];
    const re = landmarks[LANDMARK.RIGHT_EAR];

    // 1. 肩の水平度（左右肩のy差）
    const shoulderTilt = ls.y - rs.y;
    // 2. 骨盤の水平度（左右腰のy差）
    const hipTilt = lh.y - rh.y;
    // 3. 頭部の傾き（左右耳のy差）
    const headTilt = le.y - re.y;
    // 4. 体の中心軸ズレ（肩中点と腰中点のx差）
    const shoulderMidX = (ls.x + rs.x) / 2;
    const hipMidX = (lh.x + rh.x) / 2;
    const axisOffset = shoulderMidX - hipMidX;

    const scoreShoulder = metricScore(shoulderTilt, 0.04);
    const scoreHip = metricScore(hipTilt, 0.04);
    const scoreHead = metricScore(headTilt, 0.04);
    const scoreAxis = metricScore(axisOffset, 0.04);

    const total = scoreShoulder + scoreHip + scoreHead + scoreAxis;

    return {
      score: total,
      metrics: [
        { label: "肩の水平度", value: scoreShoulder, raw: shoulderTilt },
        { label: "骨盤の水平度", value: scoreHip, raw: hipTilt },
        { label: "頭部の傾き", value: scoreHead, raw: headTilt },
        { label: "体の中心軸", value: scoreAxis, raw: axisOffset },
      ],
    };
  }

  // 骨格のみを描画した（生画像を含まない）キャンバスを返す。
  // 履歴比較・保存用のサムネイル素材として利用する。
  function renderSkeleton(landmarks, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f8f9fa";
    ctx.fillRect(0, 0, width, height);

    if (typeof drawConnectors === "function" && typeof POSE_CONNECTIONS !== "undefined") {
      drawConnectors(ctx, landmarks, POSE_CONNECTIONS, {
        color: "#06c755",
        lineWidth: 3,
      });
    }
    if (typeof drawLandmarks === "function") {
      drawLandmarks(ctx, landmarks, {
        color: "#e53935",
        lineWidth: 1,
        radius: 3,
      });
    }
    return canvas;
  }

  // landmarks を保存用にJSON化（visibilityは不要なので落とす）
  function serializeLandmarks(landmarks) {
    return landmarks.map((p) => ({
      x: +p.x.toFixed(4),
      y: +p.y.toFixed(4),
      z: +p.z.toFixed(4),
    }));
  }

  global.PoseAnalyzer = {
    analyze,
    evaluate,
    renderSkeleton,
    serializeLandmarks,
    LANDMARK,
  };
})(window);
