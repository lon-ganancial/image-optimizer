    function formatBytes(n) {
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
      return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    }
    function savings(n) {
      const pct = Math.round((1 - n / currentFile.size) * 100);
      if (pct > 0) return { text: `${pct}% smaller`, cls: 'small-good' };
      if (pct < 0) return { text: `${Math.abs(pct)}% larger`, cls: 'small-bad' };
      return { text: 'Same size', cls: 'small-muted' };
    }
    function showToast(message) {
      const el = $('toast'); el.textContent = message; el.hidden = false;
      clearTimeout(toastTimeout); toastTimeout = setTimeout(() => { el.hidden = true; }, 3500);
    }
    function sourceFormat() {
      if (!currentFile) return '';
      const type = currentFile.type.toLowerCase();
      const ext = currentFile.name.split('.').pop().toLowerCase();
      if (type === 'image/jpeg' || ['jpg', 'jpeg'].includes(ext)) return 'jpeg';
      if (type === 'image/png' || ext === 'png') return 'png';
      if (type === 'image/webp' || ext === 'webp') return 'webp';
      if (type === 'image/avif' || ext === 'avif') return 'avif';
      return '';
    }
    function canPreserveOriginal(key) { return !!currentFile && sourceFormat() === key; }
    function optionsFor(key) { return optionsByFormat[key]; }
    function cacheKey(fmtKey) { return fmtKey + ':' + JSON.stringify(optionsFor(fmtKey)); }
    function setLoadingVisible(show, label = 'Generating preview…') {
      for (const id of ['sliderLoading','sideLoading']) {
        const el = $(id); if (!el) continue;
        const labelEl = el.querySelector('.mini-progress-label');
        if (labelEl) labelEl.textContent = label;
        el.hidden = !show;
      }
    }
    async function decodeObjectUrl(url) {
      const img = new Image(); img.src = url;
      if (img.decode) await img.decode();
      else await new Promise((resolve,reject) => { img.onload=resolve; img.onerror=reject; });
    }
    function positionPopover() {
      if (popover.hidden || !optAnchor) return;
      const box = optAnchor.getBoundingClientRect();
      const rect = {top:box.top/appScale, bottom:box.bottom/appScale,
        left:box.left/appScale, right:box.right/appScale, width:box.width/appScale};
      const viewportWidth = innerWidth/appScale, viewportHeight = innerHeight/appScale;
      popover.style.maxHeight = appScale < 1 ? `${Math.max(0, viewportHeight-24)}px` : '';
      const width = popover.offsetWidth, height = popover.offsetHeight;
      const left = Math.max(12, Math.min(viewportWidth-width-12, rect.right-width+7));
      const above = rect.top >= height+22 || rect.top > viewportHeight-rect.bottom;
      const top = above ? Math.max(12,rect.top-height-10) : Math.min(viewportHeight-height-12,rect.bottom+10);
      popover.classList.toggle('above', above);
      popover.style.left = `${left}px`;
      popover.style.top = `${top}px`;
      popover.style.setProperty('--arrow-right',`${Math.max(12,Math.min(width-18,left+width-(rect.left+rect.width/2)-5))}px`);
    }
    function isOptionAvailable(format, def) {
      const opts = optionsFor(format);
      const large = !!sourceCanvas && Math.max(sourceCanvas.width,sourceCanvas.height) > 2560;
      return !(
        (!opts.removeMetadata && canPreserveOriginal(format)) ||
        (def.onlyLarge && !large) || (def.needsAlpha && !hasAlpha) ||
        (def.needsLossy && !opts.compress) || (def.needsOxipng && !opts.oxipng) ||
        (format === 'jpeg' && def.id === 'coding' && opts.progressive) ||
        (codecStatus.get(format) === 'browser' && !['compress','resize'].includes(def.id))
      );
    }
    function makeOptionRow(fmt,def) {
      const label=document.createElement('label'); label.className='codec-check-row';
      const input=document.createElement('input');input.type='checkbox';input.dataset.option=def.id;
      const words=document.createElement('span');
      const title=document.createElement('strong');title.textContent=def.title;
      const desc=document.createElement('small');desc.textContent=codecStatus.get(fmt)==='browser' && def.id==='compress'
        ? 'Uncheck for maximum browser quality; output may still be lossy.' : def.info;
      words.append(title,desc);label.append(input,words);
      input.addEventListener('change',() => {
        optionsFor(fmt)[def.id]=input.checked;
        updateOptimizationPopover();
        // Invalidate this format only. Never blank or re-position the current preview.
        if (sourceCanvas) requestFormat(fmt);
      });
      return label;
    }
    function updateOptimizationPopover() {
      if (!selected) return;
      const fmt = formats.find(x=>x.key===selected);
      const state=codecStatus.get(selected);
      $('optimizationStatus').textContent = state==='wasm' ? fmt.label+' · WASM' : state==='browser' ? fmt.label+' · Browser' : fmt.label;
      const main=$('mainOptimizationList'),advanced=$('advancedOptions');
      const wasAdvancedVisible=!advanced.hidden;
      main.replaceChildren(); advanced.replaceChildren();
      let visibleAdvancedCount = 0;
      let visibleMainCount = 0;
      for (const def of CHECKS[selected]) {
        if (!isOptionAvailable(selected, def)) continue;
        const row=makeOptionRow(selected,def);
        row.querySelector('input').checked=!!optionsFor(selected)[def.id];
        if (def.advanced) {
          advanced.append(row);
          visibleAdvancedCount++;
        } else {
          main.append(row);
          visibleMainCount++;
        }
      }
      // Metadata can only be kept without re-encoding the original format. Be explicit.
      const keepOriginal=canPreserveOriginal(selected);
      if (keepOriginal) {
        const row=makeOptionRow(selected,{id:'removeMetadata',title:'Strip metadata',info:'Uncheck to keep the original file completely unchanged (other optimizations bypassed).'});
        row.querySelector('input').checked=optionsFor(selected).removeMetadata;
        main.append(row);
        visibleMainCount++;
      }
      $('advancedToggle').hidden = visibleAdvancedCount === 0;
      advanced.hidden = visibleAdvancedCount === 0 || !wasAdvancedVisible;
      $('advancedToggle').setAttribute('aria-expanded', String(!advanced.hidden));
      const info=$('codecInfo');
      info.textContent = !optionsFor(selected).removeMetadata && canPreserveOriginal(selected)
        ? 'Preserving the original file bypasses all other optimizations.'
        : state==='browser'
          ? 'WASM unavailable. Only the supported controls for this format are shown.'
          : 'Only applicable optimizations are shown. The file size is measured after encoding; an individual change may not always reduce it.';
      if (visibleMainCount === 0 && visibleAdvancedCount === 0) {
        const empty = document.createElement('div');
        empty.className = 'opt-popover-note';
        empty.textContent = 'No adjustable optimizations are available for this format right now.';
        main.append(empty);
      }
      if (!popover.hidden) requestAnimationFrame(positionPopover);
    }
    function closeOptimizationPopover(){popover.hidden=true;optAnchor=null;optToggles.forEach(b=>b.setAttribute('aria-expanded','false'));}
    function toggleOptimizationPopover(button){
      if(!popover.hidden&&optAnchor===button){closeOptimizationPopover();return;}
      optAnchor=button;optToggles.forEach(b=>b.setAttribute('aria-expanded',String(b===button)));
      popover.hidden=false;updateOptimizationPopover();positionPopover();
    }
    optToggles.forEach(b=>b.addEventListener('click',()=>toggleOptimizationPopover(b)));
    document.addEventListener('pointerdown',e=>{
      // Format selections update the open popover in place. Other outside clicks dismiss it.
      const switchingFormat = e.target instanceof Element && !!e.target.closest('.format[data-format]');
      if(!popover.hidden && !popover.contains(e.target) &&
         !optToggles.some(b=>b.contains(e.target)) && !switchingFormat) {
        closeOptimizationPopover();
      }
    });
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!popover.hidden){const b=optAnchor;closeOptimizationPopover();b?.focus();}});
    window.addEventListener('scroll',positionPopover,{passive:true});
    window.addEventListener('resize',positionPopover);
    $('advancedToggle').addEventListener('click',()=>{
      const open=$('advancedOptions').hidden;
      $('advancedOptions').hidden=!open;
      $('advancedToggle').setAttribute('aria-expanded',String(open));
      positionPopover();
    });


    $('chooseButton').addEventListener('click', () => input.click());
    $('replaceButton').addEventListener('click', () => input.click());
    input.addEventListener('change', e => {
      if (e.target.files?.length) handleFile(e.target.files[0]);
      input.value = '';
    });
    $('downloadButton').addEventListener('click', download);
    for (const b of formatButtons) b.addEventListener('click', () => requestFormat(b.dataset.format));

    // Document-wide drop target. It works on both the empty screen and comparison screen.
    const overlay = $('dropOverlay');
    let dragDepth = 0;
    function containsFiles(e) { return [...(e.dataTransfer?.types || [])].includes('Files'); }
    window.addEventListener('dragenter', e => {
      if (!containsFiles(e)) return;
      e.preventDefault(); dragDepth++; overlay.hidden = false;
    });
    window.addEventListener('dragover', e => {
      if (!containsFiles(e)) return;
      e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', e => {
      if (!containsFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) overlay.hidden = true;
    });
    window.addEventListener('drop', e => {
      e.preventDefault(); dragDepth = 0; overlay.hidden = true;
      if (e.dataTransfer?.files?.length) handleFile(e.dataTransfer.files[0]);
    });
    window.addEventListener('dragend', () => { dragDepth = 0; overlay.hidden = true; });
    window.addEventListener('paste', e => {
      if (e.clipboardData?.files?.length) handleFile(e.clipboardData.files[0]);
    });
    setSplit(50); renderView();
    window.addEventListener('beforeunload', () => { resetCodecWorkers(); clearResults(); });
