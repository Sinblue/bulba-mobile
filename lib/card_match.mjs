// 卡圖比對規則（手機第 1 階段）：拍到的照片 → 找出資料庫裡「同一張圖」的卡。
// 做法：ORB 特徵點 → LSH 索引投票挑候選 → 只對前幾名做比值測試＋RANSAC 幾何驗證，以 inliers 當分數。
// 需要 OpenCV 的函式由呼叫端傳入 cv（worker 用 vendor/opencv.js，Node 測試用同一份），本模組不載入 OpenCV。
// 參數與門檻的依據：plans/workorders/WO-002_mobile-phase1-scan_2026-09-26.md「可行性實驗結果」。
import { buildKinds, normalizeNumber } from './mobile_format.mjs';

/** 參數或演算法改變時加一，手機上快取的參考特徵會重算。 */
export const MATCH_VERSION = 1;

export const MATCH_PARAMS = Object.freeze({
  refFeatures: 500,     // 參考圖（匯出縮圖，寬 360px）ORB 點數
  queryFeatures: 1500,  // 照片 ORB 點數
  queryMaxSide: 1000,   // 照片長邊縮到幾 px
  tables: 10,           // LSH 表數
  bits: 12,             // 每表取幾個位元當桶號
  maxDistance: 64,      // 投票時 Hamming 距離上限（ORB 描述子 256 位元）
  verifyTop: 8,         // 只驗證票數前幾名
  ratio: 0.75,          // Lowe 比值測試
  ransacPx: 5,          // RANSAC 重投影誤差
  high: 15,             // inliers ≥ 此值，且 ≥ 第 1 名的 relative 倍：很可能
  relative: 0.5,
  low: 8,               // inliers ≥ 此值：可能；以下不顯示
  seed: 12345,          // LSH 取位元的亂數種子（固定，結果可重現）
});

const BYTES = 32; // ORB 描述子 32 bytes

export function popcount32(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

function rng(seed) {
  return () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) | 0) >>> 0) / 2 ** 32;
}

const keyOf = (bytes, offset, bitList) => {
  let key = 0;
  for (const bit of bitList) key = (key << 1) | ((bytes[offset + (bit >> 3)] >> (bit & 7)) & 1);
  return key;
};

/**
 * 從 RGBA 影像（ImageData 或 {data,width,height}）取 ORB 特徵。
 * 回傳 { points: Float32Array(x,y…), descriptors: Uint8Array(count*32), count }，不留任何 OpenCV 物件。
 */
export function extractFeatures(cv, image, maxFeatures) {
  const rgba = cv.matFromImageData(image);
  const gray = new cv.Mat();
  const mask = new cv.Mat();
  const orb = new cv.ORB(maxFeatures);
  const keypoints = new cv.KeyPointVector();
  const descriptors = new cv.Mat();
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    orb.detectAndCompute(gray, mask, keypoints, descriptors);
    const count = descriptors.rows;
    const points = new Float32Array(count * 2);
    for (let i = 0; i < count; i += 1) {
      const point = keypoints.get(i).pt;
      points[2 * i] = point.x;
      points[2 * i + 1] = point.y;
    }
    return { points, descriptors: new Uint8Array(descriptors.data.slice(0, count * BYTES)), count };
  } finally {
    rgba.delete(); gray.delete(); mask.delete(); orb.delete(); keypoints.delete(); descriptors.delete();
  }
}

/** 照片縮放後的尺寸：長邊不超過 maxSide，不放大。 */
export function fitSize(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** 把所有參考圖的描述子接起來，建 LSH 索引。refs: [{ key, descriptors, count }] */
export function buildIndex(refs, params = MATCH_PARAMS) {
  const total = refs.reduce((sum, ref) => sum + ref.count, 0);
  const bytes = new Uint8Array(total * BYTES);
  const owner = new Int32Array(total);
  let at = 0;
  refs.forEach((ref, index) => {
    bytes.set(ref.descriptors.subarray(0, ref.count * BYTES), at * BYTES);
    owner.fill(index, at, at + ref.count);
    at += ref.count;
  });
  const random = rng(params.seed);
  const size = 1 << params.bits;
  const tables = [];
  for (let t = 0; t < params.tables; t += 1) {
    const bitList = [];
    while (bitList.length < params.bits) {
      const bit = Math.floor(random() * 256);
      if (!bitList.includes(bit)) bitList.push(bit);
    }
    const keys = new Uint32Array(total);
    const start = new Int32Array(size + 1);
    for (let i = 0; i < total; i += 1) { keys[i] = keyOf(bytes, i * BYTES, bitList); start[keys[i] + 1] += 1; }
    for (let k = 0; k < size; k += 1) start[k + 1] += start[k];
    const fill = start.slice(0, size);
    const items = new Int32Array(total);
    for (let i = 0; i < total; i += 1) items[fill[keys[i]]++] = i;
    tables.push({ bitList, start, items });
  }
  return { total, refCount: refs.length, words: new Uint32Array(bytes.buffer), owner, tables };
}

/** 每個照片特徵點找索引中最近的點（同桶內比 Hamming），距離夠近就替那張參考圖投一票。 */
export function voteCandidates(index, query, params = MATCH_PARAMS) {
  const votes = new Float32Array(index.refCount);
  const qBytes = query.descriptors;
  const qWords = new Uint32Array(qBytes.buffer, qBytes.byteOffset, (query.count * BYTES) >> 2);
  const seen = new Int32Array(index.total).fill(-1);
  for (let i = 0; i < query.count; i += 1) {
    let best = 257;
    let bestItem = -1;
    for (const table of index.tables) {
      const key = keyOf(qBytes, i * BYTES, table.bitList);
      for (let p = table.start[key]; p < table.start[key + 1]; p += 1) {
        const item = table.items[p];
        if (seen[item] === i) continue;
        seen[item] = i;
        let distance = 0;
        for (let w = 0; w < 8; w += 1) distance += popcount32(qWords[i * 8 + w] ^ index.words[item * 8 + w]);
        if (distance < best) { best = distance; bestItem = item; }
      }
    }
    if (bestItem >= 0 && best < params.maxDistance) votes[index.owner[bestItem]] += 1;
  }
  return votes;
}

/** 票數前 k 名（有票的才算）的參考圖索引。 */
export function topCandidates(votes, k) {
  return [...votes.keys()].filter((i) => votes[i] > 0).sort((a, b) => votes[b] - votes[a] || a - b).slice(0, k);
}

/** 比值測試＋RANSAC，回傳幾何上一致的配對數（inliers）。 */
export function verifyMatch(cv, ref, query, params = MATCH_PARAMS) {
  if (ref.count < 8 || query.count < 8) return 0;
  const refMat = cv.matFromArray(ref.count, BYTES, cv.CV_8U, ref.descriptors);
  const queryMat = cv.matFromArray(query.count, BYTES, cv.CV_8U, query.descriptors);
  const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const pairs = new cv.DMatchVectorVector();
  const src = [];
  const dst = [];
  try {
    matcher.knnMatch(refMat, queryMat, pairs, 2);
    for (let i = 0; i < pairs.size(); i += 1) {
      const pair = pairs.get(i);
      if (pair.size() < 2) continue;
      const a = pair.get(0);
      if (a.distance < params.ratio * pair.get(1).distance) {
        src.push(ref.points[2 * a.queryIdx], ref.points[2 * a.queryIdx + 1]);
        dst.push(query.points[2 * a.trainIdx], query.points[2 * a.trainIdx + 1]);
      }
    }
  } finally {
    refMat.delete(); queryMat.delete(); matcher.delete(); pairs.delete();
  }
  const good = src.length / 2;
  if (good < 8) return 0;
  const from = cv.matFromArray(good, 1, cv.CV_32FC2, src);
  const to = cv.matFromArray(good, 1, cv.CV_32FC2, dst);
  const mask = new cv.Mat();
  const homography = cv.findHomography(from, to, cv.RANSAC, params.ransacPx, mask);
  try {
    if (homography.empty()) return 0;
    const h = homography.data64F;
    const det = h[0] * h[4] - h[1] * h[3];
    // 翻面或極度變形的對應不合理
    return det > 0.001 && det < 1000 ? cv.countNonZero(mask) : 0;
  } finally {
    from.delete(); to.delete(); mask.delete(); homography.delete();
  }
}

/** 完整比對：投票挑候選 → 驗證 → 依 inliers 由高到低。回傳 [{ key, inliers }]。 */
export function matchQuery(cv, index, refs, query, params = MATCH_PARAMS) {
  const votes = voteCandidates(index, query, params);
  return topCandidates(votes, params.verifyTop)
    .map((i) => ({ key: refs[i].key, inliers: verifyMatch(cv, refs[i], query, params) }))
    .sort((a, b) => b.inliers - a.inliers);
}

/** 依門檻分級，低於 low 的丟掉；遠低於第 1 名的只算「可能」。回傳依分數由高到低。 */
export function classifyMatches(matches, params = MATCH_PARAMS) {
  const top = Math.max(0, ...matches.map((match) => match.inliers));
  return matches
    .filter((match) => match.inliers >= params.low)
    .sort((a, b) => b.inliers - a.inliers)
    .map((match) => ({
      ...match,
      level: match.inliers >= params.high && match.inliers >= top * params.relative ? 'high' : 'maybe',
    }));
}

/**
 * 對到的縮圖 → 卡種，再依「代碼＋卡號」合併成組（同一張卡的日文圖、繁中圖是不同檔案，但應同一組）。
 * 組的分數與等級取組內最高；組內卡種依各自縮圖的分數排列，最像的語言在前。
 */
export function matchGroups(classified, rows) {
  const groups = new Map();
  for (const match of classified) {
    for (const kind of buildKinds(rows.filter((row) => row.thumb === match.key))) {
      const key = `${kind.code}|${normalizeNumber(kind.number)}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, inliers: match.inliers, level: match.level, kinds: [] };
        groups.set(key, group);
      }
      if (!group.kinds.some((existing) => existing.kindKey === kind.kindKey)) group.kinds.push(kind);
    }
  }
  return [...groups.values()];
}
