// 姿勢解析モジュール（臨床メソドロジー版 v2）
//
// 設計方針:
//   - 全処理を患者の端末ブラウザ内で完結（プライバシー）
//   - MediaPipe Pose の 33 ランドマーク + visibility を活用
//   - 撮影品質ゲート（立位・全身可視・正面/側面判定）を通らない場合はスコアを出さない
//   - 各指標を「度」単位で算出し、正常域と逸脱度を明示
//   - 姿勢パターンは俗称で表示し、ケンダル分類は限界を明示した近似値として補助情報に
//
// 参考:
//   - Kendall, FP. "Muscles: Testing and Function with Posture and Pain"
//   - Penha PJ et al. "Postural assessment of girls between 7 and 10 years of age"
//   - PostureScreen Mobile (PostureCo) のスクリーニング項目
//
// 重要: 本解析は「姿勢傾向の参考情報」であり、医学的診断ではない。
(function (global) {
  "use strict";

  // MediaPipe Pose 33点インデックス
  const LM = {
    NOSE: 0,
    LEFT_EYE_INNER: 1, LEFT_EYE: 2, LEFT_EYE_OUTER: 3,
    RIGHT_EYE_INNER: 4, RIGHT_EYE: 5, RIGHT_EYE_OUTER: 6,
    LEFT_EAR: 7, RIGHT_EAR: 8,
    MOUTH_LEFT: 9, MOUTH_RIGHT: 10,
    LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
    LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
    LEFT_WRIST: 15, RIGHT_WRIST: 16,
    LEFT_PINKY: 17, RIGHT_PINKY: 18,
    LEFT_INDEX: 19, RIGHT_INDEX: 20,
    LEFT_THUMB: 21, RIGHT_THUMB: 22,
    LEFT_HIP: 23, RIGHT_HIP: 24,
    LEFT_KNEE: 25, RIGHT_KNEE: 26,
    LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
    LEFT_HEEL: 29, RIGHT_HEEL: 30,
    LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32,
  };

  // ランドマーク日本語ラベル（可視化用）
  const LABELS_JA = {
    [LM.NOSE]: "鼻",
    [LM.LEFT_EAR]: "左耳", [LM.RIGHT_EAR]: "右耳",
    [LM.LEFT_SHOULDER]: "左肩峰", [LM.RIGHT_SHOULDER]: "右肩峰",
    [LM.LEFT_ELBOW]: "左肘", [LM.RIGHT_ELBOW]: "右肘",
    [LM.LEFT_HIP]: "左腸骨", [LM.RIGHT_HIP]: "右腸骨",
    [LM.LEFT_KNEE]: "左膝", [LM.RIGHT_KNEE]: "右膝",
    [LM.LEFT_ANKLE]: "左外果", [LM.RIGHT_ANKLE]: "右外果",
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
      modelComplexity: 2, // 1→2 で精度向上
      smoothLandmarks: true,
      enableSegmentation: false,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6,
    });
    poseInstance.onResults((results) => {
      lastResults = results;
    });
    return poseInstance;
  }

  async function analyze(source) {
    const pose = ensurePose();
    lastResults = null;
    await pose.send({ image: source });
    if (!lastResults || !lastResults.poseLandmarks) {
      throw new Error("姿勢を検出できませんでした。明るい場所で全身が画面に入るように撮影してください。");
    }
    return lastResults;
  }

  // ===== 幾何ユーティリティ =====
  const toDeg = (rad) => rad * 180 / Math.PI;

  // 線分が水平からの傾き（度）。値が正なら左下がり（右上がり）。
  function lineTiltDeg(a, b) {
    // 画像座標は y が下向き正。水平からの符号付き角度。
    return toDeg(Math.atan2(b.y - a.y, b.x - a.x));
  }

  // 線分が垂直からの傾き（度）。0 が真っ直ぐ立っている状態。
  function lineFromVerticalDeg(top, bottom) {
    const dx = bottom.x - top.x;
    const dy = bottom.y - top.y;
    return toDeg(Math.atan2(dx, dy));
  }

  // 3点の内角（p2を頂点として p1-p2-p3 の角度を度で返す）
  function angleAt(p1, p2, p3) {
    const v1x = p1.x - p2.x, v1y = p1.y - p2.y;
    const v2x = p3.x - p2.x, v2y = p3.y - p2.y;
    const dot = v1x * v2x + v1y * v2y;
    const mag = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1e-9;
    return toDeg(Math.acos(Math.max(-1, Math.min(1, dot / mag))));
  }

  function mid(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 };
  }

  function visible(landmarks, i, threshold = 0.5) {
    const v = landmarks[i] && (landmarks[i].visibility ?? landmarks[i].presence ?? 1);
    return v >= threshold;
  }

  // ===== 撮影品質ゲート =====
  // 立位・全身可視・撮影アングル判定を行う。スコア算出可否を判断。
  function evaluateQuality(landmarks) {
    const warnings = [];

    const requiredVisible = [
      [LM.LEFT_SHOULDER, "左肩"], [LM.RIGHT_SHOULDER, "右肩"],
      [LM.LEFT_HIP, "左腰"], [LM.RIGHT_HIP, "右腰"],
      [LM.LEFT_KNEE, "左膝"], [LM.RIGHT_KNEE, "右膝"],
      [LM.LEFT_ANKLE, "左足首"], [LM.RIGHT_ANKLE, "右足首"],
    ];
    const missing = requiredVisible.filter(([i]) => !visible(landmarks, i)).map(([, name]) => name);
    const fullBody = missing.length === 0;
    if (!fullBody) {
      warnings.push(`次の部位が検出できません: ${missing.join("・")}。全身が画面に入るように撮影してください。`);
    }

    // 立位判定: 肩中点→腰中点→膝中点→足首中点 がほぼ垂直に並ぶ
    const ls = landmarks[LM.LEFT_SHOULDER], rs = landmarks[LM.RIGHT_SHOULDER];
    const lh = landmarks[LM.LEFT_HIP], rh = landmarks[LM.RIGHT_HIP];
    const lk = landmarks[LM.LEFT_KNEE], rk = landmarks[LM.RIGHT_KNEE];
    const la = landmarks[LM.LEFT_ANKLE], ra = landmarks[LM.RIGHT_ANKLE];

    const sM = mid(ls, rs), hM = mid(lh, rh), kM = mid(lk, rk), aM = mid(la, ra);

    // 胸郭〜骨盤〜膝〜足首が縦に並んでいるか（座位だと膝が前に来てこの並びが崩れる）
    const trunkLen = Math.abs(sM.y - hM.y);
    const legLen = Math.abs(hM.y - aM.y);
    const isLikelyStanding = trunkLen > 0.15 && legLen > trunkLen * 0.8;

    // 膝の角度（伸展していれば180°近い）
    const leftKneeAngle = angleAt(lh, lk, la);
    const rightKneeAngle = angleAt(rh, rk, ra);
    const kneeExtended = (leftKneeAngle + rightKneeAngle) / 2 > 155;

    const standing = isLikelyStanding && kneeExtended;
    if (!standing && fullBody) {
      warnings.push(`立位ではない可能性があります（膝平均角度 ${((leftKneeAngle + rightKneeAngle) / 2).toFixed(0)}°）。両足で立って正面を向いて撮影してください。`);
    }

    // 撮影アングル: 正面 vs 側面
    const shoulderSpread = Math.abs(ls.x - rs.x);
    const hipSpread = Math.abs(lh.x - rh.x);
    const ls_vis = ls.visibility ?? 1, rs_vis = rs.visibility ?? 1;
    let view = "unknown";
    if (shoulderSpread > 0.10) {
      view = "frontal";
    } else if (shoulderSpread < 0.04) {
      view = ls_vis > rs_vis + 0.15 ? "left_side" : (rs_vis > ls_vis + 0.15 ? "right_side" : "oblique");
    } else {
      view = "oblique";
    }

    const canScore = fullBody && standing && view === "frontal";
    if (fullBody && standing && view !== "frontal") {
      warnings.push(`正面撮影として認識できませんでした（${viewLabel(view)}と推定）。本ツールは現在「正面立位」の評価のみ対応しています。`);
    }

    return {
      fullBody,
      standing,
      view,
      kneeAngle: { left: leftKneeAngle, right: rightKneeAngle },
      shoulderSpread,
      hipSpread,
      canScore,
      warnings,
    };
  }

  function viewLabel(view) {
    return { frontal: "正面", left_side: "左側面", right_side: "右側面", oblique: "斜め", unknown: "判定不能" }[view] || view;
  }

  // ===== 重症度分類 =====
  // 各指標の |deviation| を「正常域(±tol)」「軽度(±2*tol)」「中等度(±3*tol)」「顕著」に分ける
  function classify(absDev, tol) {
    if (absDev <= tol) return "normal";
    if (absDev <= tol * 2) return "mild";
    if (absDev <= tol * 3) return "moderate";
    return "severe";
  }
  function severityScore(sev) {
    return { normal: 25, mild: 18, moderate: 10, severe: 3 }[sev] || 0;
  }
  function severityLabel(sev) {
    return { normal: "正常域", mild: "軽度", moderate: "中等度", severe: "顕著" }[sev] || sev;
  }

  // ===== 臨床メトリクス（正面立位） =====
  // 各指標は文献ベースの参考正常域（個体差あり）を採用。
  function evaluateFrontal(landmarks) {
    const ls = landmarks[LM.LEFT_SHOULDER], rs = landmarks[LM.RIGHT_SHOULDER];
    const lh = landmarks[LM.LEFT_HIP], rh = landmarks[LM.RIGHT_HIP];
    const le = landmarks[LM.LEFT_EAR], re = landmarks[LM.RIGHT_EAR];
    const lk = landmarks[LM.LEFT_KNEE], rk = landmarks[LM.RIGHT_KNEE];
    const la = landmarks[LM.LEFT_ANKLE], ra = landmarks[LM.RIGHT_ANKLE];
    const nose = landmarks[LM.NOSE];

    const sM = mid(ls, rs), hM = mid(lh, rh);

    // 1) 肩線傾斜角（参考正常域 ±2°）
    const shoulderTilt = lineTiltDeg(ls, rs);
    // 2) 骨盤線傾斜角（参考正常域 ±2°）
    const pelvicTilt = lineTiltDeg(lh, rh);
    // 3) 頭部側方偏位: 鼻のx位置と肩中点のx差を肩幅で正規化、角度換算（参考 ±3°）
    const shoulderWidth = Math.hypot(ls.x - rs.x, ls.y - rs.y) || 1e-9;
    const headLateralShiftRatio = (nose.x - sM.x) / shoulderWidth;
    const headLateralDeg = toDeg(Math.atan(headLateralShiftRatio));
    // 4) 体幹軸の傾き（肩中点→骨盤中点、垂直から ±2°）
    const trunkTilt = lineFromVerticalDeg(sM, hM);
    // 5) 頭部傾斜（左右耳の傾斜、参考 ±2°）
    const headTilt = lineTiltDeg(le, re);
    // 6) 膝アライメント: 左右の膝のX字/O字傾向 — Q角の簡易代替
    //    両膝中点と両足首中点のずれを骨盤幅で正規化
    const kneeMid = mid(lk, rk), ankleMid = mid(la, ra);
    const kneeOffsetRatio = (kneeMid.x - ankleMid.x) / (Math.abs(lh.x - rh.x) || 1e-9);
    const kneeAlignmentDeg = toDeg(Math.atan(kneeOffsetRatio));

    const metrics = [
      buildMetric({
        key: "shoulder_tilt",
        label: "肩の傾き",
        clinicalName: "肩線傾斜角 (frontal shoulder tilt)",
        valueDeg: shoulderTilt,
        normalAbsDeg: 2,
        positiveSide: "右上がり",
        negativeSide: "左上がり",
        explanation: "両肩を結ぶ線が水平からどれだけ傾いているか。利き腕側の肩下がり、肩こりや僧帽筋の左右差で増大します。",
      }),
      buildMetric({
        key: "pelvic_tilt",
        label: "骨盤の傾き",
        clinicalName: "骨盤線傾斜角 (pelvic obliquity, frontal)",
        valueDeg: pelvicTilt,
        normalAbsDeg: 2,
        positiveSide: "右上がり",
        negativeSide: "左上がり",
        explanation: "両腸骨を結ぶ線の水平からの傾き。脚長差や中殿筋の機能不全で増大します。",
      }),
      buildMetric({
        key: "head_lateral",
        label: "頭部の左右偏位",
        clinicalName: "頭部側方偏位 (lateral head shift)",
        valueDeg: headLateralDeg,
        normalAbsDeg: 3,
        positiveSide: "右へ偏位",
        negativeSide: "左へ偏位",
        explanation: "鼻が左右肩の中点からどれだけ横にずれているか。頸椎の側屈や視覚的補正で偏位します。",
      }),
      buildMetric({
        key: "trunk_tilt",
        label: "体幹の左右傾き",
        clinicalName: "体幹軸傾斜 (frontal trunk lean)",
        valueDeg: trunkTilt,
        normalAbsDeg: 2,
        positiveSide: "右へ傾斜",
        negativeSide: "左へ傾斜",
        explanation: "肩中点と骨盤中点を結ぶ線の垂直からのズレ。荷重の左右差や側弯の指標になります。",
      }),
      buildMetric({
        key: "head_tilt",
        label: "頭部の左右傾斜",
        clinicalName: "頭部側方傾斜 (head lateral tilt)",
        valueDeg: headTilt,
        normalAbsDeg: 2,
        positiveSide: "右下がり",
        negativeSide: "左下がり",
        explanation: "両耳を結ぶ線の水平からの傾き。胸鎖乳突筋・斜角筋の左右差で増大します。",
      }),
      buildMetric({
        key: "knee_alignment",
        label: "膝のアライメント",
        clinicalName: "膝内反/外反傾向 (Q-angle proxy, frontal)",
        valueDeg: kneeAlignmentDeg,
        normalAbsDeg: 4,
        positiveSide: "X脚傾向（外反）",
        negativeSide: "O脚傾向（内反）",
        explanation: "膝の左右中点が足首中点に対して内側か外側かの傾向。下肢アライメントの簡易評価です。",
      }),
    ];

    // 総合スコア: 上位5指標の severityScore 合計（最大125）→ 100点満点に正規化
    // 膝は補助とし、フロントスコアには含めない（25×4=100 がコア）
    const core = metrics.slice(0, 4);
    const totalScore = Math.round(core.reduce((s, m) => s + m.severityScore, 0));

    // 姿勢パターン分類（俗称ベース）
    const patterns = classifyFrontalPatterns(metrics);

    return { metrics, score: totalScore, patterns };
  }

  function buildMetric({ key, label, clinicalName, valueDeg, normalAbsDeg, positiveSide, negativeSide, explanation }) {
    const abs = Math.abs(valueDeg);
    const severity = classify(abs, normalAbsDeg);
    const sScore = severityScore(severity);
    const sign = valueDeg > 0.1 ? positiveSide : valueDeg < -0.1 ? negativeSide : "中立";
    return {
      key, label, clinicalName,
      valueDeg: +valueDeg.toFixed(1),
      normalRangeDeg: [-normalAbsDeg, normalAbsDeg],
      severity,
      severityLabel: severityLabel(severity),
      severityScore: sScore,
      direction: sign,
      explanation,
    };
  }

  function classifyFrontalPatterns(metrics) {
    const m = Object.fromEntries(metrics.map((x) => [x.key, x]));
    const patterns = [];
    if (m.shoulder_tilt.severity !== "normal") {
      patterns.push(`肩の左右差（${m.shoulder_tilt.direction}, ${Math.abs(m.shoulder_tilt.valueDeg)}°）`);
    }
    if (m.pelvic_tilt.severity !== "normal") {
      patterns.push(`骨盤の左右差（${m.pelvic_tilt.direction}, ${Math.abs(m.pelvic_tilt.valueDeg)}°）`);
    }
    if (m.head_tilt.severity !== "normal") {
      patterns.push(`頭部側屈（${m.head_tilt.direction}）`);
    }
    if (m.head_lateral.severity !== "normal") {
      patterns.push(`頭部の側方偏位（${m.head_lateral.direction}）`);
    }
    if (m.trunk_tilt.severity !== "normal") {
      patterns.push(`体幹の側方傾斜（${m.trunk_tilt.direction}）`);
    }
    if (m.knee_alignment.severity !== "normal") {
      patterns.push(`下肢アライメント（${m.knee_alignment.direction}）`);
    }
    return patterns;
  }

  // ===== 姿勢一言サマリ =====
  // 「つまりなんという姿勢なのか」を1行で表現する。最重症の指標から命名する。
  const TARGET_SCORE = 85; // 目標スコア（コア4指標が全て正常〜軽度におさまる目安）
  const SEV_RANK = { normal: 0, mild: 1, moderate: 2, severe: 3 };

  function buildSummaryLabel(metrics, score) {
    if (!metrics.length) return "—";
    const coreKeys = ["shoulder_tilt", "pelvic_tilt", "head_lateral", "trunk_tilt"];
    const core = metrics.filter((m) => coreKeys.includes(m.key));
    const worst = [...core].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])[0];

    if (!worst || worst.severity === "normal") {
      if (score >= 95) return "ほぼ理想的な正面立位";
      return "概ね均整のとれた正面立位";
    }

    const abn = core.filter((m) => m.severity !== "normal");
    const tags = abn.map((m) => {
      switch (m.key) {
        case "shoulder_tilt": return `${m.direction}の肩`;
        case "pelvic_tilt": return `${m.direction}の骨盤`;
        case "head_lateral": return `頭部${m.direction}`;
        case "trunk_tilt": return `体幹${m.direction}`;
      }
    }).filter(Boolean);

    const sevWord = severityLabel(worst.severity);
    if (tags.length === 1) return `${sevWord}な${tags[0]}傾向`;
    if (tags.length === 2) return `${sevWord}な${tags.join("・")}傾向`;
    return `複合姿勢（${tags.slice(0, 2).join("・")} など${tags.length}項目）`;
  }

  // ===== 総合 evaluate() =====
  function evaluate(landmarks) {
    const quality = evaluateQuality(landmarks);
    if (!quality.canScore) {
      return {
        quality,
        score: null,
        metrics: [],
        patterns: [],
        summaryLabel: null,
        targetScore: TARGET_SCORE,
        kendallNote: KENDALL_LIMITATION_NOTE,
      };
    }
    const result = evaluateFrontal(landmarks);
    return {
      quality,
      score: result.score,
      metrics: result.metrics,
      patterns: result.patterns,
      summaryLabel: buildSummaryLabel(result.metrics, result.score),
      targetScore: TARGET_SCORE,
      kendallNote: KENDALL_LIMITATION_NOTE,
    };
  }

  const KENDALL_LIMITATION_NOTE = [
    "本ツールは正面立位のスクリーニングです。",
    "Kendall の4分類（Ideal / Kyphosis-Lordosis / Sway-back / Flat-back）は側面像での脊柱湾曲評価が前提のため、本ツールでは厳密な分類は行いません。",
    "側面評価は今後のバージョンで対応予定です。",
  ].join(" ");

  // ===== 可視化 =====
  // 原画 + 半透明スケルトン + 主要ランドマーク ラベル を1枚に描く
  function renderAnnotated(landmarks, originalCanvasOrImage, width, height, opts) {
    opts = opts || {};
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    // 原画を描画（あれば）
    if (originalCanvasOrImage) {
      ctx.drawImage(originalCanvasOrImage, 0, 0, width, height);
      // 半透明の白ベール
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.fillRect(0, 0, width, height);
    } else {
      ctx.fillStyle = "#f8f9fa";
      ctx.fillRect(0, 0, width, height);
    }

    if (typeof drawConnectors === "function" && typeof POSE_CONNECTIONS !== "undefined") {
      drawConnectors(ctx, landmarks, POSE_CONNECTIONS, {
        color: "rgba(6, 199, 85, 0.85)",
        lineWidth: 3,
      });
    }
    if (typeof drawLandmarks === "function") {
      drawLandmarks(ctx, landmarks, {
        color: "rgba(229, 57, 53, 0.95)",
        lineWidth: 1,
        radius: 4,
      });
    }

    // 垂直プラムライン（肩中点→骨盤中点を延長して垂直基準として描画）
    if (opts.plumbLine !== false) {
      const ls = landmarks[LM.LEFT_SHOULDER], rs = landmarks[LM.RIGHT_SHOULDER];
      const lh = landmarks[LM.LEFT_HIP], rh = landmarks[LM.RIGHT_HIP];
      if (ls && rs && lh && rh) {
        const sM = mid(ls, rs);
        ctx.strokeStyle = "rgba(33, 150, 243, 0.7)";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(sM.x * width, 0);
        ctx.lineTo(sM.x * width, height);
        ctx.stroke();
        ctx.setLineDash([]);
        // 水平基準線（肩線）
        ctx.strokeStyle = "rgba(33, 150, 243, 0.4)";
        ctx.beginPath();
        ctx.moveTo(0, ((ls.y + rs.y) / 2) * height);
        ctx.lineTo(width, ((ls.y + rs.y) / 2) * height);
        ctx.stroke();
      }
    }

    // 主要点のラベル
    if (opts.labels !== false) {
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.lineWidth = 3;
      Object.entries(LABELS_JA).forEach(([idx, label]) => {
        const lm = landmarks[+idx];
        if (!lm || (lm.visibility || 1) < 0.5) return;
        const x = lm.x * width + 6;
        const y = lm.y * height - 4;
        ctx.strokeText(label, x, y);
        ctx.fillText(label, x, y);
      });
    }

    return canvas;
  }

  // 既存コードとの互換のためのシンプル骨格描画
  function renderSkeleton(landmarks, width, height) {
    return renderAnnotated(landmarks, null, width, height, { plumbLine: false, labels: false });
  }

  function serializeLandmarks(landmarks) {
    return landmarks.map((p) => ({
      x: +p.x.toFixed(4),
      y: +p.y.toFixed(4),
      z: +(p.z || 0).toFixed(4),
      visibility: +(p.visibility || 0).toFixed(3),
    }));
  }

  global.PoseAnalyzer = {
    analyze,
    evaluate,
    renderAnnotated,
    renderSkeleton,
    serializeLandmarks,
    LANDMARK: LM,
    LABELS_JA,
  };
})(window);
