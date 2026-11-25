
    'use strict';
    const appRoot = document.getElementById('appRoot');
    let appScale = 1;
    function updateAppScale() {
      appScale = Math.min(1, document.documentElement.clientWidth / 320);
      appRoot.style.zoom = appScale < 1 ? String(appScale) : '';
      appRoot.style.width = appScale < 1 ? '320px' : '';
      const noticeHeight = document.querySelector('.viewport-notice').getBoundingClientRect().height;
      document.querySelector('.page').style.minHeight = appScale < 1
        ? `${Math.max(0, innerHeight-noticeHeight)/appScale}px` : '';
    }
    updateAppScale();
    window.addEventListener('resize', updateAppScale);
    const $ = id => document.getElementById(id);
    const input = $('fileInput');
    const formatButtons = [...document.querySelectorAll('[data-format]')];
    const formats = [
      { key:'webp', label:'WebP', mime:'image/webp', ext:'webp' },
      { key:'avif', label:'AVIF', mime:'image/avif', ext:'avif' },
      { key:'jpeg', label:'JPG', mime:'image/jpeg', ext:'jpg' },
      { key:'png', label:'PNG', mime:'image/png', ext:'png' }
    ];
    // One AVIF worker and one shared worker for JPEG/WebP/PNG.
    // Workers are lazy; local modules and WASM binaries load inside them only.
    const workerSlots = new Map();
    let workerTaskId = 0;
    function createCodecWorker(slot) {
      const worker = new Worker('js/codec.worker.js', {type:'module'});
      const pending = new Map();
      const state = {worker, pending};
      worker.onmessage = ({data}) => {
        const job = pending.get(data.id);
        if (!job) return;
        pending.delete(data.id);
        if (data.ok) job.resolve(data);
        else job.reject(new Error(data.error || 'WASM codec failed'));
      };
      worker.onerror = (event) => {
        const err = new Error(event.message || `Encoding worker (${slot}) failed`);
        for (const job of pending.values()) job.reject(err);
        pending.clear();
        if (workerSlots.get(slot) === state) workerSlots.delete(slot);
        worker.terminate();
      };
      workerSlots.set(slot, state);
      return state;
    }
    function postWorker(state, message, transfer = []) {
      const id = ++workerTaskId;
      return new Promise((resolve, reject) => {
        state.pending.set(id, {resolve, reject});
        try { state.worker.postMessage({...message, id}, transfer); }
        catch (error) { state.pending.delete(id); reject(error); }
      });
    }
    async function initializeWorkerSource(state, source, imageEpoch, scanAlpha = false) {
      if (!state.sourceReady) {
        state.sourceReady = (async () => {
          const bitmap = await createImageBitmap(source);
          if (imageEpoch !== run) { bitmap.close(); throw new Error('Image replaced'); }
          try { return await postWorker(state, {action:'init', bitmap, scanAlpha}, [bitmap]); }
          catch (error) { bitmap.close(); throw error; }
        })();
      }
      return state.sourceReady;
    }
    async function encodeWithWorker(format, opts, imageEpoch) {
      const slot = format === 'avif' ? 'avif' : 'standard';
      const state = workerSlots.get(slot) || createCodecWorker(slot);
      const needsResize = opts.resize && Math.max(sourceCanvas.width,sourceCanvas.height)>2560;
      const key = `${format === 'jpeg' ? 'white' : 'alpha'}:${!!needsResize}`;
      if (state.preparedKey === key) {
        try { return (await postWorker(state, {action:'encode', format, opts, useCached:true, cacheKey:key})).buffer; }
        catch (error) { state.preparedKey=null; throw error; }
      }
      state.preparedKey=null;
      if (workerPreparation && !needsResize) {
        await initializeWorkerSource(state, sourceCanvas, imageEpoch);
        if (imageEpoch !== run) return null;
        const result=await postWorker(state, {action:'encode', format, opts});
        if (imageEpoch !== run) return null;
        state.preparedKey=sourceCanvas.width*sourceCanvas.height*4 <= 64*1024*1024 ? key : null;
        return result.buffer;
      }
      const prepared = await prepareOnMainThread(opts, format, imageEpoch);
      if (!prepared) return null;
      const {imageData, canvas} = prepared;
      try {
        if (imageEpoch !== run) return null;
        const cacheable=imageData.data.byteLength<=64*1024*1024;
        const result=await postWorker(state, {action:'encode', format, opts, cacheKey:key,
          width:imageData.width, height:imageData.height, pixels:imageData.data.buffer},
          [imageData.data.buffer]);
        if (imageEpoch !== run) return null;
        state.preparedKey=cacheable ? key : null;
        return result.buffer;
      } finally { canvas.width = canvas.height = 0; }
    }
    // Bound pending work to one active job per worker and one queued job per format.
    const encodingLanes = new Map();
    function scheduleEncoding(format, task, onCancel) {
      const slot = format === 'avif' ? 'avif' : 'standard';
      if (!encodingLanes.has(slot)) encodingLanes.set(slot, {active:false, waiting:new Map()});
      const lane = encodingLanes.get(slot);
      return new Promise((resolve, reject) => {
        const previous = lane.waiting.get(format);
        if (previous) { previous.onCancel(); previous.resolve(null); lane.waiting.delete(format); }
        lane.waiting.set(format, {task, resolve, reject, onCancel});
        drainEncodingLane(lane);
      });
    }
    function drainEncodingLane(lane) {
      if (lane.active || !lane.waiting.size) return;
      const format = lane.waiting.has(selected) ? selected : lane.waiting.keys().next().value;
      const job = lane.waiting.get(format);
      lane.waiting.delete(format); lane.active = true;
      Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => {
        lane.active = false; drainEncodingLane(lane);
      });
    }
    function cancelQueuedEncodes() {
      for (const lane of encodingLanes.values()) {
        for (const job of lane.waiting.values()) { job.onCancel(); job.resolve(null); }
        lane.waiting.clear();
      }
    }
    // Decoding cannot be aborted in all browsers: keep only the latest waiting file.
    const sourceDecodeLane = {active:false, waiting:null};
    function cancelQueuedSourceDecode() {
      if (sourceDecodeLane.waiting) sourceDecodeLane.waiting.resolve(null);
      sourceDecodeLane.waiting=null;
    }
    function decodeLatestSource(file, imageEpoch) {
      cancelQueuedSourceDecode();
      return new Promise((resolve,reject) => {
        sourceDecodeLane.waiting={file,imageEpoch,resolve,reject};
        drainSourceDecode();
      });
    }
    function drainSourceDecode() {
      if (sourceDecodeLane.active || !sourceDecodeLane.waiting) return;
      const job=sourceDecodeLane.waiting;
      sourceDecodeLane.waiting=null;sourceDecodeLane.active=true;
      drawFile(job.file,job.imageEpoch).then(job.resolve,job.reject).finally(() => {
        sourceDecodeLane.active=false;drainSourceDecode();
      });
    }
    const codecStatus = new Map(); // wasm/browser/original
    const DEFAULT_OPTIONS = Object.freeze({
      webp: { compress:true, alpha:true, effort:true },
      jpeg: { compress:true, chroma:true, progressive:true, coding:true, trellis:false },
      avif: { compress:true, chroma:true, effort:false },
      png: { oxipng:true, effort:false }
    });
    let optionsByFormat = Object.fromEntries(Object.entries(DEFAULT_OPTIONS).map(([k,v]) => [k, {...v, resize:false, removeMetadata:true}]));
    const CHECKS = {
      webp: [
        { id:'compress', title:'Compress image details', info:'Uncheck for lossless WebP encoding after canvas conversion.' },
        { id:'alpha', title:'Compress transparency', info:'Reduce transparency precision slightly.', needsAlpha:true, needsLossy:true },
        { id:'effort', title:'Stronger encoding', info:'Spend more processing time to seek a smaller file.' },
        { id:'resize', title:'Reduce large dimensions', info:'Limit the longest edge to 2560 px.', onlyLarge:true }
      ],
      jpeg: [
        { id:'compress', title:'Compress image details', info:'Uncheck to use maximum JPEG quality (still lossy).' },
        { id:'chroma', title:'Reduce color detail', info:'Use chroma subsampling; uncheck for full color detail.' },
        { id:'progressive', title:'Progressive encoding', info:'Use progressive scans; savings depend on the image.' },
        { id:'coding', title:'Optimize Huffman tables', info:'Optimize coding tables; encoder decisions can also change image details.' },
        { id:'resize', title:'Reduce large dimensions', info:'Limit the longest edge to 2560 px.', onlyLarge:true },
        { id:'trellis', title:'Trellis optimization', info:'Additional JPEG quantization search. May be slower.', advanced:true }
      ],
      avif: [
        { id:'compress', title:'Compress image details', info:'Uncheck for lossless AVIF after canvas conversion (larger and slower).' },
        { id:'chroma', title:'Reduce color detail (4:2:0)', info:'Uncheck to preserve full-color detail (4:4:4).', needsLossy:true },
        { id:'effort', title:'Stronger encoding', info:'Slower AVIF encoding; may reduce file size.' },
        { id:'resize', title:'Reduce large dimensions', info:'Limit the longest edge to 2560 px.', onlyLarge:true }
      ],
      png: [
        { id:'oxipng', title:'Optimize losslessly', info:'Encode with OxiPNG without loss after canvas conversion.' },
        { id:'resize', title:'Reduce large dimensions', info:'Limit the longest edge to 2560 px.', onlyLarge:true },
        { id:'effort', title:'Maximum compression effort', info:'Try a stronger, slower lossless optimization level.', advanced:true, needsOxipng:true }
      ]
    };
    let currentFile = null;
    let selected = 'webp';
    let results = {};
    let originalUrl = null;
    let run = 0;
    let comboCache = new Map();
    let pendingCache = new Map();
    let toastTimeout = null;
    // The decoded canvas also supplies the pixel-identical compatibility path.
    let sourceCanvas = null;
    let workerPreparation = false;
    let sourcePreparing = false;
    let hasAlpha = true;
    let requestedVersion = 0;
    let appliedKey = null;
    let optAnchor = null;
    const optToggles = [$('sliderOptToggle'), $('sideOptToggle')];
    const popover = $('optimizationPopover');


    function resetCodecWorkers(){
      cancelQueuedSourceDecode();
      cancelQueuedEncodes();
      for (const state of workerSlots.values()) {
        for (const job of state.pending.values()) job.reject(new Error('Image replaced'));
        state.pending.clear();state.worker.terminate();
      }
      workerSlots.clear();
    }
    function clearResults(invalidate = true){
      if (invalidate) ++run;
      for(const entry of comboCache.values()) URL.revokeObjectURL(entry.url);
      comboCache.clear();pendingCache.clear();results={};
      if(originalUrl) URL.revokeObjectURL(originalUrl);
      originalUrl=null;selected='webp';appliedKey=null;
      setLoadingVisible(false);
      if(sourceCanvas){
        if (typeof sourceCanvas.close === 'function') sourceCanvas.close();
        else sourceCanvas.width=sourceCanvas.height=0;
        sourceCanvas=null;
      }
      workerPreparation=false;sourcePreparing=false;
      closeOptimizationPopover();
    }
    function setFormatPending(fmtKey) {
      const b=formatButtons.find(x=>x.dataset.format===fmtKey);
      if(!b)return;
      b.disabled=false;
      b.querySelector('.fmt-size').textContent='…';
      b.querySelector('.fmt-saving').textContent='Generating…';
      b.querySelector('.fmt-saving').className='fmt-saving small-muted';
    }
    function setFormatResult(fmtKey,result,error) {
      const b=formatButtons.find(x=>x.dataset.format===fmtKey);
      if(!b)return;
      if(!result){
        b.disabled=true;
        b.querySelector('.fmt-size').textContent='—';
        b.querySelector('.fmt-saving').textContent='Unavailable';
        b.querySelector('.fmt-saving').className='fmt-saving small-muted';
        b.title=error?.code==='PREVIEW_DECODE_FAILED'
          ? 'This browser cannot display the encoded preview' : 'This format could not be encoded';
        return;
      }
      b.disabled=false;b.title=result.engine==='wasm' ? 'Encoded by jSquash WASM' : result.engine==='original' ? 'Original file unchanged' : 'Encoded with browser fallback';
      b.querySelector('.fmt-size').textContent=formatBytes(result.blob.size);
      const stat=savings(result.blob.size);
      b.querySelector('.fmt-saving').textContent=stat.text;
      b.querySelector('.fmt-saving').className='fmt-saving '+stat.cls;
    }
    function updateFormatSelection(){
      for(const b of formatButtons){
        const active=b.dataset.format===selected;
        b.classList.toggle('selected',active);
        b.setAttribute('aria-pressed',String(active));
        b.querySelector('.tick').hidden=!active;
      }
    }
    function commitResult(fmtKey,result){
      // The new URL has already decoded. Never show a placeholder between variants.
      appliedKey=result.key;
      $('sliderOptimizedImage').src=result.url;
      $('optimizedImage').src=result.url;
      $('sliderOptimizedImage').hidden=false;
      $('optimizedImage').hidden=false;
      $('sliderWait').hidden=true;
      $('previewWait').hidden=true;
      $('optimizedLabel').textContent=formats.find(f=>f.key===fmtKey).label+(result.engine==='browser'?' · Browser fallback':'');
      $('optimizedSize').textContent=formatBytes(result.blob.size);
      $('sliderOptimizedSize').textContent=formatBytes(result.blob.size);
      const stat=savings(result.blob.size);
      $('optimizedSaving').textContent=stat.text;
      $('sliderSaving').textContent=stat.text;
      $('sliderSaving').className='saving'+(stat.cls==='small-bad'?' larger':'');
      $('optimizedSaving').className='saving'+(stat.cls==='small-bad'?' larger':'');
      $('downloadText').textContent='Download '+formats.find(f=>f.key===fmtKey).label;
      $('downloadButton').disabled=false;
      optToggles.forEach(b=>b.disabled=false);
      setLoadingVisible(false);
      trimCache();
      updateOptimizationPopover();
    }
    function formatLoading() {
      for (const b of formatButtons) {
        b.disabled=false;
        b.classList.remove('selected');b.setAttribute('aria-pressed','false');
        b.querySelector('.tick').hidden=true;
        b.querySelector('.fmt-size').textContent='…';
        b.querySelector('.fmt-saving').textContent='Queued';
      }
    }
    function toBlob(canvas, mime, quality) {
      return new Promise(resolve => {
        try {
          canvas.toBlob(blob => {
            // Unsupported formats can silently fall back to PNG.
            resolve(blob && blob.type.toLowerCase() === mime ? blob : null);
          }, mime, quality);
        } catch { resolve(null); }
      });
    }
    async function drawFile(file, imageEpoch) {
      const url = URL.createObjectURL(file);
      try {
        if ('createImageBitmap' in window) {
          try {
            const bitmap = await createImageBitmap(file);
            try {
              if (imageEpoch!==run) return null;
              const canvas = document.createElement('canvas');
              canvas.width = bitmap.width; canvas.height = bitmap.height;
              if (!canvas.width || !canvas.height) throw new Error('Invalid image size.');
              const ctx = canvas.getContext('2d');
              if (!ctx) throw new Error('Canvas is not available.');
              ctx.drawImage(bitmap, 0, 0);
              return canvas;
            } finally { bitmap.close(); }
          } catch (e) { if (imageEpoch!==run) return null; /* Try HTMLImageElement next. */ }
        }
        const img = new Image();
        img.src = url;
        await img.decode();
        if (imageEpoch!==run) return null;
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        if (!canvas.width || !canvas.height) throw new Error('Invalid image size.');
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas is not available.');
        ctx.drawImage(img, 0, 0);
        return canvas;
      } finally { URL.revokeObjectURL(url); }
    }
    function createEncodingImageData(options,fmtKey,source=sourceCanvas) {
      const reduce=options.resize && Math.max(source.width,source.height)>2560;
      const scale=reduce ? 2560/Math.max(source.width,source.height) : 1;
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(source.width*scale));
      canvas.height=Math.max(1,Math.round(source.height*scale));
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      if(fmtKey==='jpeg'){ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);}
      ctx.imageSmoothingQuality='high';
      ctx.drawImage(source,0,0,canvas.width,canvas.height);
      const imageData=ctx.getImageData(0,0,canvas.width,canvas.height);
      return { imageData, canvas };
    }
    async function prepareOnMainThread(opts, format, imageEpoch) {
      if (imageEpoch!==run) return null;
      return createEncodingImageData(opts,format);
    }
    async function nativeFallback(fmt,opts,canvas) {
      // Clearly marked fallback. Never pretend unsupported encoder checkboxes were applied.
      const quality=opts.compress ? .82 : 1;
      return toBlob(canvas,fmt.mime,quality);
    }
    async function encodeForFormat(fmt, opts, imageEpoch) {
      if (imageEpoch !== run) return null;
      if (!opts.removeMetadata && canPreserveOriginal(fmt.key)) return {blob:currentFile, engine:'original'};
      if (!sourceCanvas) return null;
      try {
        const buffer = await encodeWithWorker(fmt.key, opts, imageEpoch);
        if (imageEpoch !== run) return null;
        if (!buffer) throw Error('Empty output');
        const blob = new Blob([buffer], {type:fmt.mime});
        if (!blob.size) throw Error('Empty output');
        codecStatus.set(fmt.key, 'wasm');
        return {blob, engine:'wasm'};
      } catch (error) {
        if (imageEpoch !== run) return null;
        console.warn(`[Image Optimizer] ${fmt.label} worker codec unavailable; using browser encoding`, error);
        codecStatus.set(fmt.key, 'browser');
        const prepared = await prepareOnMainThread(opts, fmt.key, imageEpoch);
        if (!prepared) return null;
        const {canvas} = prepared;
        try {
          if (imageEpoch !== run) return null;
          const blob = await nativeFallback(fmt, opts, canvas);
          return blob ? {blob, engine:'browser'} : null;
        } finally { canvas.width = canvas.height = 0; }
      }
    }
    const MAX_CACHE=24, MAX_CACHE_BYTES=64 * 1024 * 1024;
    function trimCache(keepKey){
      let bytes = [...comboCache.values()].reduce((total,item)=>total+item.blob.size,0);
      while(comboCache.size>MAX_CACHE || bytes>MAX_CACHE_BYTES){
        let victim;
        for (const key of comboCache.keys()) {
          if (key!==appliedKey && key!==cacheKey(selected) && key!==keepKey) {victim=key;break;}
        }
        if (victim===undefined) break;
        const item=comboCache.get(victim);
        bytes-=item.blob.size; URL.revokeObjectURL(item.url); comboCache.delete(victim);
        for (const key of Object.keys(results)) if (results[key] === item) delete results[key];
      }
    }
    async function ensureResult(fmtKey) {
      const key=cacheKey(fmtKey);
      if(comboCache.has(key))return comboCache.get(key);
      if(pendingCache.has(key))return pendingCache.get(key).job;
      const opts={...optionsFor(fmtKey)};
      const fmt=formats.find(f=>f.key===fmtKey);
      const imageEpoch=run;
      const record={job:null};
      const job=scheduleEncoding(fmtKey, async()=>{
        const encoded=await encodeForFormat(fmt,opts,imageEpoch);
        if(!encoded || imageEpoch!==run)return null;
        const url=URL.createObjectURL(encoded.blob);
        try {await decodeObjectUrl(url);} catch(error) {
          URL.revokeObjectURL(url);
          const issue=new Error('The browser could not decode the encoded preview');
          issue.code='PREVIEW_DECODE_FAILED';throw issue;
        }
        if(imageEpoch!==run){URL.revokeObjectURL(url);return null;}
        const result={...encoded,url,key};
        comboCache.set(key,result);trimCache(key);
        return result;
      }, ()=>{if(pendingCache.get(key)===record)pendingCache.delete(key);});
      record.job=job;pendingCache.set(key,record);
      try{return await job;}finally{if(pendingCache.get(key)===record)pendingCache.delete(key);}
    }
    async function requestFormat(fmtKey) {
      if (sourcePreparing) { selected=fmtKey; updateFormatSelection(); return; }
      if(!sourceCanvas)return;
      selected=fmtKey;updateFormatSelection();
      if (!popover.hidden) updateOptimizationPopover();
      const request=++requestedVersion;
      const imageEpoch=run;
      const key=cacheKey(fmtKey);
      const cached=comboCache.get(key);
      // Do not flash loading for revisits. On first generation keep old image painted.
      setLoadingVisible(!cached);
      $('downloadButton').disabled=!cached;
      if(!cached){$('downloadText').textContent='Generating…';setFormatPending(fmtKey);}
      try {
        const result = cached || await ensureResult(fmtKey);
        if (request!==requestedVersion || imageEpoch!==run) return;
        if (!result) throw new Error('No supported encoder returned an image');
        results[fmtKey]=result;
        setFormatResult(fmtKey,result);
        commitResult(fmtKey,result);
      } catch(error) {
        if(request!==requestedVersion || imageEpoch!==run)return;
        console.error(`[Image Optimizer] ${fmtKey} failed`,error);
        setLoadingVisible(false);
        $('downloadButton').disabled=true;
        $('downloadText').textContent='Unavailable';
        setFormatResult(fmtKey,null,error);
        showToast(error.code==='PREVIEW_DECODE_FAILED'
          ? 'This browser cannot display the '+fmtKey.toUpperCase()+' preview.'
          : 'Could not encode '+fmtKey.toUpperCase()+' in this browser.');
      }
    }
    async function generateDefaults(token) {
      const priority=['webp','jpeg','png','avif'];
      for(const key of priority){
        if(token!==run)return;
        const requested=cacheKey(key);
        // Skip default result when the user has changed these options already.
        try {
          const res=await ensureResult(key);
          if(token!==run)return;
          if (!res) throw new Error('No supported encoder returned an image');
          if(cacheKey(key)===requested){
            results[key]=res;setFormatResult(key,res);
            if(key===selected && requestedVersion===0)commitResult(key,res);
          }
        } catch(error){
          console.error(`[Image Optimizer] ${key} could not generate or preview`,error);
          if(token!==run)return;
          if(cacheKey(key)===requested){
            setFormatResult(key,null,error);
            if(key===selected && requestedVersion===0){
              setLoadingVisible(false); $('downloadText').textContent='Unavailable';
              showToast(error.code==='PREVIEW_DECODE_FAILED'
                ? 'This browser cannot display the '+key.toUpperCase()+' preview.'
                : 'Could not encode '+key.toUpperCase()+' in this browser.');
            }
          }
        }
      }
    }
    async function handleFile(file) {
      if(!file)return;
      if(!file.type.startsWith('image/')&&!/\.(png|jpe?g|webp|avif|gif|bmp|heic|heif)$/i.test(file.name)){
        showToast('Please choose an image file.');return;
      }
      const token=++run;
      ++requestedVersion;
      optionsByFormat=Object.fromEntries(Object.entries(DEFAULT_OPTIONS).map(([k,v])=>[k,{...v,resize:false,removeMetadata:true}]));
      codecStatus.clear();
      $('workState').style.setProperty('--image-aspect','16 / 9');
      imageAspect=16/9;resetView();resetCodecWorkers();clearResults(false);currentFile=file;sourcePreparing=true;
      $('emptyState').hidden=true;$('workState').hidden=false;
      document.querySelector('.page').classList.add('has-image');
      $('fileDetails').textContent=file.name;
      $('originalSize').textContent=formatBytes(file.size);
      $('sliderOriginalSize').textContent=formatBytes(file.size);
      $('originalType').textContent=(file.type.split('/')[1]||file.name.split('.').pop()||'IMAGE').toUpperCase();
      originalUrl=URL.createObjectURL(file);
      $('originalImage').src=originalUrl;$('sliderOriginalImage').src=originalUrl;
      for(const id of ['sliderOptimizedImage','optimizedImage']){$(id).hidden=true;$(id).removeAttribute('src');}
      $('sliderWait').hidden=true;$('previewWait').hidden=true;
      $('sliderOptimizedSize').textContent='—';$('sliderSaving').textContent='—';
      $('optimizedSize').textContent='—';$('optimizedSaving').textContent='—';
      $('optimizedLabel').textContent='Preparing…';
      $('downloadButton').disabled=true;$('downloadText').textContent='Preparing…';
      $('formatStatus').textContent='Preparing optimized images…';
      formatLoading();updateFormatSelection();setLoadingVisible(true);
      optToggles.forEach(b=>b.disabled=true);
      try {
        const source=await decodeLatestSource(file,token);
        if (!source) return;
        if(token!==run){source.width=source.height=0;return;}
        sourceCanvas=source;
        workerPreparation=typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function';
        $('workState').style.setProperty('--image-aspect',`${source.width} / ${source.height}`);
        imageAspect=source.width/source.height;renderView();
        $('fileDetails').textContent=`${file.name} · ${source.width.toLocaleString()} × ${source.height.toLocaleString()} px`;
        let alphaKnown=false;
        if (workerPreparation) {
          try {
            const state=workerSlots.get('standard') || createCodecWorker('standard');
            hasAlpha=(await initializeWorkerSource(state,source,token,true)).hasAlpha;
            alphaKnown=true;
            // Worker canvas rounding differs by one RGB level for some translucent
            // pixels. Retain the established canvas path for these images.
            if (hasAlpha) {
              await postWorker(state,{action:'releaseSource'});
              state.preparedKey=null;
              if(token!==run)return;
              workerPreparation=false;
            }
          } catch(error) {
            if(token!==run)return;
            console.warn('[Image Optimizer] Worker preparation unavailable; using canvas preparation',error);
            workerPreparation=false;
          }
        }
        if(token!==run)return;
        if (!workerPreparation && !alphaKnown) {
          const ctx=source.getContext('2d',{willReadFrequently:true});
          const pixels=ctx.getImageData(0,0,source.width,source.height).data;
          hasAlpha=false;
          for(let i=3;i<pixels.length;i+=4){if(pixels[i]<255){hasAlpha=true;break;}}
        }
        sourcePreparing=false;
        requestedVersion=0;
        generateDefaults(token);
        if(selected!=='webp') requestFormat(selected);
      } catch(error){
        if(token!==run)return;
        sourcePreparing=false;
        console.error(error);
        resetCodecWorkers();clearResults();
        for (const fmt of formats) setFormatResult(fmt.key,null,error);
        setLoadingVisible(false);
        $('optimizedLabel').textContent='Unavailable';
        $('formatStatus').textContent='Unable to process image';
        showToast('Could not read this image in your browser.');
      }
    }
    function download() {
      if (!selected || !results[selected] || results[selected].key!==cacheKey(selected) || !currentFile) return;
      const fmt = formats.find(f => f.key === selected);
      const base = currentFile.name.replace(/\.[^.]+$/, '') || 'image';
      const a = document.createElement('a');
      a.href = results[selected].url;
      const unchanged = !optionsFor(selected).removeMetadata && canPreserveOriginal(selected);
      a.download = `${base}-${unchanged ? 'original' : 'optimized'}.${fmt.ext}`;
      document.body.append(a); a.click(); a.remove();
    }
