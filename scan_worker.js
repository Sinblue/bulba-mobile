// 卡圖比對的背景執行緒：載入 OpenCV、計算參考特徵、比對照片。規則都在 lib/card_match.mjs。
// 訊息：{ id, type: 'prepare' | 'load' | 'match', ... } → 回覆 { id, type: 'done' | 'error' | 'progress', ... }
importScripts('vendor/opencv.js');

let cvReady = null;
let lib = null;
let refs = null;
let index = null;

async function ready() {
  cvReady ??= (async () => {
    if (typeof self.cv?.Mat !== 'function') {
      if (self.cv instanceof Promise) self.cv = await self.cv;
      else await new Promise((resolve) => { self.cv.onRuntimeInitialized = resolve; });
    }
    lib = await import('./lib/card_match.mjs');
  })();
  return cvReady;
}

async function imageDataOf(blob, maxSide) {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const { width, height } = maxSide ? lib.fitSize(bitmap.width, bitmap.height, maxSide) : bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return context.getImageData(0, 0, width, height);
}

function useRefs(next) {
  refs = next;
  index = lib.buildIndex(refs, lib.MATCH_PARAMS);
}

async function prepare(id, thumbs) {
  const next = [];
  let done = 0;
  for (const [key, url] of thumbs) {
    try {
      const blob = await (await fetch(url)).blob();
      const features = lib.extractFeatures(self.cv, await imageDataOf(blob), lib.MATCH_PARAMS.refFeatures);
      next.push({ key, ...features });
    } catch { /* 單張縮圖壞掉就略過，不影響其他卡 */ }
    done += 1;
    if (done % 10 === 0 || done === thumbs.length) postMessage({ id, type: 'progress', done, total: thumbs.length });
  }
  useRefs(next);
  return { refs: next, version: lib.MATCH_VERSION };
}

async function match(blob) {
  if (!index) throw new Error('參考特徵尚未準備好');
  const started = performance.now();
  const image = await imageDataOf(blob, lib.MATCH_PARAMS.queryMaxSide);
  const query = lib.extractFeatures(self.cv, image, lib.MATCH_PARAMS.queryFeatures);
  const matches = lib.matchQuery(self.cv, index, refs, query, lib.MATCH_PARAMS);
  return { matches, ms: Math.round(performance.now() - started), points: query.count };
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    await ready();
    let result;
    if (type === 'prepare') result = await prepare(id, data.thumbs);
    else if (type === 'load') { useRefs(data.refs); result = { count: refs.length }; }
    else if (type === 'match') result = await match(data.blob);
    else throw new Error(`未知的指令 ${type}`);
    postMessage({ id, type: 'done', result });
  } catch (error) {
    postMessage({ id, type: 'error', message: String(error?.message ?? error) });
  }
};
