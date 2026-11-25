
'use strict';
// Separate workers are used for AVIF and other formats to avoid long AVIF jobs
// blocking a newly requested JPEG or WebP encoding.
const CODECS = Object.freeze({
  webp: '../assets/codecs/webp/encode.js', jpeg: '../assets/codecs/jpeg/encode.js',
  avif: '../assets/codecs/avif/encode.js', png: '../assets/codecs/png/encode.js',
  oxipng: '../assets/codecs/oxipng/optimise.js'
});
const modules = new Map();
function load(key) {
  if (!modules.has(key)) modules.set(key, import(CODECS[key]).catch(error => {
    modules.delete(key);
    throw error;
  }));
  return modules.get(key);
}
// One source and at most one reusable prepared RGBA variant per worker.
let sourceCanvas = null;
let prepared = null;
const MAX_PREPARED_BYTES = 64 * 1024 * 1024;
function preparePixels(format) {
  if (!sourceCanvas) throw Error('Worker source is not initialized');
  const key = `${format === 'jpeg' ? 'white' : 'alpha'}:false`;
  if (prepared && prepared.key === key) return prepared.image;
  prepared = null;
  const canvas = new OffscreenCanvas(sourceCanvas.width, sourceCanvas.height);
  const ctx = canvas.getContext('2d', {willReadFrequently:true});
  if (!ctx) throw Error('Worker canvas unavailable');
  if (format === 'jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas,0,0,canvas.width,canvas.height);
  const image = ctx.getImageData(0,0,canvas.width,canvas.height);
  canvas.width = canvas.height = 0;
  if (image.data.byteLength <= MAX_PREPARED_BYTES) prepared = {key, image};
  return image;
}
self.onmessage = async ({data}) => {
  const {id, format, opts, width, height, pixels} = data;
  try {
    if (data.action === 'releaseSource') {
      sourceCanvas = null; prepared = null;
      self.postMessage({id, ok:true}); return;
    }
    if (data.action === 'init') {
      if (typeof OffscreenCanvas !== 'function') throw Error('OffscreenCanvas unavailable');
      const bitmap = data.bitmap;
      try {
        sourceCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = sourceCanvas.getContext('2d', {willReadFrequently:true});
        if (!ctx) throw Error('Worker canvas unavailable');
        ctx.drawImage(bitmap, 0, 0);
        let hasAlpha = false;
        if (data.scanAlpha) {
          const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
          for (let i=3; i<rgba.length; i+=4) if (rgba[i]<255) { hasAlpha=true; break; }
        }
        self.postMessage({id, ok:true, hasAlpha});
      } finally { bitmap.close(); }
      return;
    }
    let source;
    if (data.useCached) {
      if (!prepared || prepared.key !== data.cacheKey) throw Error('Prepared pixels unavailable');
      source = prepared.image;
    } else if (pixels) {
      source = new ImageData(new Uint8ClampedArray(pixels), width, height);
      prepared = source.data.byteLength <= MAX_PREPARED_BYTES ? {key:data.cacheKey, image:source} : null;
    } else source = preparePixels(format);
    let encoded;
    if (format === 'webp') {
      const {default: encode} = await load('webp');
      encoded = await encode(source, {
        quality: opts.compress ? 82 : 100,
        lossless: opts.compress ? 0 : 1,
        alpha_quality: opts.alpha ? 82 : 100,
        method: opts.effort ? 6 : 4,
        exact: 0
      });
    } else if (format === 'jpeg') {
      const {default: encode} = await load('jpeg');
      encoded = await encode(source, {
        quality: opts.compress ? 82 : 100,
        auto_subsample: false,
        chroma_subsample: opts.chroma ? 2 : 1,
        progressive: opts.progressive,
        optimize_coding: opts.coding,
        trellis_multipass: opts.trellis
      });
    } else if (format === 'avif') {
      const {default: encode} = await load('avif');
      encoded = await encode(source, {
        quality: opts.compress ? 62 : 100,
        lossless: !opts.compress,
        // jSquash: 0=YUV400 (grayscale), 1=YUV420, 2=YUV422, 3=YUV444.
        // Unchecking chroma reduction MUST preserve full color, not turn grayscale.
        subsample: opts.compress && opts.chroma ? 1 : 3,
        speed: opts.effort ? 5 : 8
      });
    } else if (format === 'png') {
      if (opts.oxipng) {
        const {default: optimise} = await load('oxipng');
        encoded = await optimise(source, {
          level: opts.effort ? 6 : 3,
          optimiseAlpha: false,
          interlace: false
        });
      } else {
        const {default: encode} = await load('png');
        encoded = await encode(source);
      }
    } else throw Error('Unsupported output format');
    if (!encoded) throw Error('Encoder returned an empty result');
    const bytes = encoded instanceof ArrayBuffer ? new Uint8Array(encoded)
      : new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    // Copy exact used bytes; WASM output may be backed by an oversized ArrayBuffer.
    const output = bytes.slice().buffer;
    self.postMessage({id, ok:true, buffer:output}, [output]);
  } catch(error) {
    if (data.action === 'init') { sourceCanvas = null; prepared = null; }
    self.postMessage({id, ok:false, error: String(error && (error.stack || error.message) || error)});
  }
};

