# スコアリング方法論

本書は AI Pose Analyzer の姿勢評価ロジックを臨床的に開示するためのドキュメントです。実装上の正常域・分類は文献ベースの簡易スクリーニング値であり、医学的診断ではありません。

---

## 1. 計測パイプライン

```
カメラ画像 (端末内)
   │
   ▼
MediaPipe Pose v0.5（33点ランドマーク, modelComplexity=2）
   │
   ▼
撮影品質ゲート（quality gate）
  - 全身可視（肩・腰・膝・足首がすべて visibility ≥ 0.5）
  - 立位（膝平均角度 > 155°、躯幹/下肢長比 > 0.8）
  - 撮影アングル分類（正面 / 左側面 / 右側面 / 斜め / 不明）
   │
   ▼  (canScore = 全身可視 ∧ 立位 ∧ 正面)
正面立位メトリクス算出（後述）
   │
   ▼
重症度分類 → 総合スコア / 姿勢パターン分類
```

`canScore` が偽の場合（例: 座位、半身、斜め撮影）はスコアを算出せず、撮影品質警告のみを表示します。

---

## 2. 撮影品質ゲート

| ゲート | 条件 | 不合格時の挙動 |
| --- | --- | --- |
| 全身可視 | 肩・腰・膝・足首の visibility がすべて 0.5 以上 | 不足部位を警告に列挙 |
| 立位判定 | 躯幹長と下肢長の比 > 0.8、両膝の内角平均 > 155° | 「立位ではない可能性」を警告 |
| 撮影アングル | 肩線の x スパン > 0.10 で「正面」、< 0.04 で「側面」（visibility 差から左右判定） | 正面以外は「現バージョン未対応」を警告 |

---

## 3. 正面立位メトリクス（v2）

各指標は **画像座標系での幾何計算 → 度（°）への変換** を行います。x は水平、y は鉛直下向きを正とする画像座標。

### 3.1 肩線傾斜角（shoulder tilt）

```
shoulderTilt = atan2(rs.y - ls.y, rs.x - ls.x)  → 度
```

- 正常域: **±2°**
- 正値: 右肩上がり / 負値: 左肩上がり
- 臨床的意義: 利き腕側の僧帽筋緊張、肩甲帯の左右差、頸椎側屈の代償

### 3.2 骨盤線傾斜角（pelvic obliquity, frontal）

```
pelvicTilt = atan2(rh.y - lh.y, rh.x - lh.x)  → 度
```

- 正常域: **±2°**
- 正値: 右骨盤上がり / 負値: 左骨盤上がり
- 臨床的意義: 機能的脚長差、中殿筋機能不全、腰椎側屈

### 3.3 頭部側方偏位（lateral head shift）

```
shoulderWidth = |ls - rs|
ratio = (nose.x - shoulderMidX) / shoulderWidth
headLateral = atan(ratio) → 度
```

- 正常域: **±3°**
- 臨床的意義: 頸椎側屈、視覚補正、優位眼の影響

### 3.4 体幹軸傾斜（frontal trunk lean）

```
trunkTilt = atan2(hipMid.x - shoulderMid.x, hipMid.y - shoulderMid.y) → 度
```

- 正常域: **±2°**
- 臨床的意義: 荷重の左右差、機能性側弯、外側支持機構の不均衡

### 3.5 頭部側方傾斜（head lateral tilt）

```
headTilt = atan2(rEar.y - lEar.y, rEar.x - lEar.x) → 度
```

- 正常域: **±2°**
- 臨床的意義: 胸鎖乳突筋・斜角筋の左右差

### 3.6 膝アライメント簡易評価（Q-angle proxy, frontal）

```
ratio = (kneeMid.x - ankleMid.x) / |lh.x - rh.x|
kneeAlignment = atan(ratio) → 度
```

- 正常域: **±4°**
- 正値: X脚傾向（外反） / 負値: O脚傾向（内反）
- 注: 真の Q-angle（ASIS-膝蓋骨-脛骨粗面）の代替指標です

---

## 4. 重症度分類と合算

各指標について：

| カテゴリ | 条件 | 配点 |
| --- | --- | --- |
| 正常域 | |dev| ≤ tol | 25 点 |
| 軽度 | tol < |dev| ≤ 2×tol | 18 点 |
| 中等度 | 2×tol < |dev| ≤ 3×tol | 10 点 |
| 高度 | 3×tol < |dev| | 3 点 |

**総合スコア** = 「肩線・骨盤線・頭部偏位・体幹軸」の4指標の合計（**25×4 = 100 点満点**）。
頭部側屈・膝アライメントは補助情報としてレポート表示のみ（総合スコアには含めない）。

---

## 5. 姿勢パターン分類（俗称ベース）

各指標が正常域外の場合、該当する俗称ラベルを付与します。

| 検出条件 | パターンラベル例 |
| --- | --- |
| shoulderTilt 異常 | 「肩の左右差（右上がり 3.5°）」 |
| pelvicTilt 異常 | 「骨盤の左右差（左上がり 4.2°）」 |
| headTilt 異常 | 「頭部側屈（右下がり）」 |
| headLateral 異常 | 「頭部の側方偏位（右へ偏位）」 |
| trunkTilt 異常 | 「体幹の側方傾斜（左へ傾斜）」 |
| kneeAlignment 異常 | 「下肢アライメント（O脚傾向）」 |

---

## 6. Kendall 分類について（重要な限界）

Florence Kendall らの古典的姿勢分類（**Ideal alignment / Kyphosis-Lordosis / Sway-back / Flat-back**）は **側面像での脊柱前後弯評価** を前提としています。本ツールは現バージョンで以下の制約があります：

1. **正面像のみ評価**: 現実装は正面撮影のスクリーニングに限定。Kendall の4分類には対応していません
2. **脊柱椎体ランドマークなし**: MediaPipe Pose は鼻・耳・肩峰・腸骨・大転子（相当）のみを返し、椎体レベルの情報はありません。側面像でも厳密な lordosis / kyphosis 計測は不能
3. **将来対応予定**: 側面撮影フローを追加し、以下の俗称ベース判定を実装予定:
   - 前方頭位姿勢（Forward Head Posture）
   - 猫背（Round-shouldered / Kyphotic tendency）
   - スウェイバック傾向（Sway-back tendency）
   - フラットバック傾向（Flat-back tendency）

---

## 7. 限界と注意事項

- **個人差**: 正常域は集団の平均値に基づく参考値。個人の関節弛緩性・骨格特性で偏移しうる
- **服装の影響**: 厚手の上着・スカート等は骨格検出を阻害する
- **撮影距離**: カメラに近すぎる/遠すぎる場合は遠近歪みで角度が誤る
- **鏡像問題**: フロントカメラ撮影は左右反転する場合があり、データ解釈時に注意
- **時系列比較の限界**: 撮影位置・服装・カメラ角度がほぼ同一でないと推移評価の信頼性は下がる

---

## 8. 参考文献・既存ツール

- Kendall FP, McCreary EK, Provance PG. *Muscles: Testing and Function with Posture and Pain.* 5th ed. Lippincott Williams & Wilkins, 2005.
- Penha PJ, João SMA, Casarotto RA et al. *Postural assessment of girls between 7 and 10 years of age.* Clinics. 2005;60(1):9-16.
- Singla D, Veqar Z. *Methods of postural assessment used for sports persons.* J Clin Diagn Res. 2014;8(4):LE01-LE04.
- PostureCo, Inc. *PostureScreen Mobile.* (商用iOSアプリ・参考メソドロジー)

---

## 9. 計算ロジックの所在

実装は `liff/js/pose.js` の以下関数を参照してください：

- `evaluateQuality(landmarks)` — 撮影品質ゲート
- `evaluateFrontal(landmarks)` — 正面メトリクス
- `buildMetric()` — 重症度分類
- `classifyFrontalPatterns(metrics)` — 俗称ラベル

何か修正したい場合は PR を歓迎します。
