
    // Shared view transforms ensure both sides show the exact same image region.
    let mode = 'slider';
    let zoom = 1;
    let panX = 0, panY = 0; // fraction of viewport dimensions, independent of mode
    // Wheel and button input update a target; one rAF loop eases the rendered view to it.
    let targetZoom = 1;
    let targetPanX = 0, targetPanY = 0;
    let viewFrame = 0, previousFrameTime = 0;
    let imageAspect = 16 / 9;
    let splitPercent = 50;
    const panViewports = [...document.querySelectorAll('.pan-viewport')];
    function activeViewport() { return mode === 'slider' ? $('sliderViewport') : panViewports[1]; }
    function panLimits(atZoom = zoom) {
      const v = activeViewport();
      const w = v.clientWidth || 1, h = v.clientHeight || 1;
      const drawnW = Math.min(w, h * imageAspect), drawnH = drawnW / imageAspect;
      return { x: Math.max(0, (drawnW * atZoom / w - 1) / 2), y: Math.max(0, (drawnH * atZoom / h - 1) / 2) };
    }
    function clampPoint(x, y, atZoom) {
      const max = panLimits(atZoom);
      return {
        x: Math.max(-max.x, Math.min(max.x, x)),
        y: Math.max(-max.y, Math.min(max.y, y))
      };
    }
    function clampPan() {
      ({ x: panX, y: panY } = clampPoint(panX, panY, zoom));
    }
    function renderView() {
      clampPan();
      for (const viewport of panViewports) {
        viewport.classList.toggle('is-zoomed', zoom > 1.001);
        for (const scene of viewport.querySelectorAll('.pan-scene')) {
          scene.style.transform = `translate3d(${panX * viewport.clientWidth}px, ${panY * viewport.clientHeight}px, 0) scale(${zoom})`;
        }
      }
      $('zoomLevel').textContent = `${Math.round(zoom * 100)}%`;
      $('zoomOut').disabled = targetZoom <= 1;
      $('zoomIn').disabled = targetZoom >= 6;
      $('zoomFit').disabled = targetZoom <= 1 && targetPanX === 0 && targetPanY === 0;
    }
    function stopViewAnimation() {
      if (viewFrame) cancelAnimationFrame(viewFrame);
      viewFrame = 0;
      previousFrameTime = 0;
    }
    function animateView(time) {
      viewFrame = 0;
      // Time-based easing stays consistent across refresh rates and batches wheel ticks.
      const elapsed = previousFrameTime ? Math.min(time - previousFrameTime, 64) : 16.7;
      previousFrameTime = time;
      const blend = 1 - Math.exp(-elapsed / 85);
      zoom += (targetZoom - zoom) * blend;
      panX += (targetPanX - panX) * blend;
      panY += (targetPanY - panY) * blend;
      const moving = Math.abs(zoom - targetZoom) > .0002 ||
        Math.abs(panX - targetPanX) > .0001 || Math.abs(panY - targetPanY) > .0001;
      if (!moving) {
        zoom = targetZoom;
        panX = targetPanX;
        panY = targetPanY;
        previousFrameTime = 0;
      }
      renderView();
      if (moving) viewFrame = requestAnimationFrame(animateView);
    }
    function requestViewAnimation() {
      if (!viewFrame) viewFrame = requestAnimationFrame(animateView);
    }
    function setZoom(value, pointerX = .5, pointerY = .5) {
      const old = targetZoom;
      targetZoom = Math.max(1, Math.min(6, value));
      if (targetZoom === 1) {
        targetPanX = targetPanY = 0;
      } else if (old !== targetZoom) {
        const ratio = targetZoom / old;
        // Keep the image detail beneath the cursor anchored as zoom targets change.
        targetPanX = targetPanX * ratio + (pointerX - .5) * (1 - ratio);
        targetPanY = targetPanY * ratio + (pointerY - .5) * (1 - ratio);
      }
      ({ x: targetPanX, y: targetPanY } = clampPoint(targetPanX, targetPanY, targetZoom));
      requestViewAnimation();
    }
    function setSplit(value) {
      splitPercent = Math.max(0, Math.min(100, Math.round(Number(value))));
      $('sliderViewport').style.setProperty('--split', `${splitPercent}%`);
      $('splitGrip').setAttribute('aria-valuenow', String(splitPercent));
      $('splitGrip').setAttribute('aria-valuetext', `${splitPercent}% original image visible`);
    }
    function setMode(next) {
      mode = next;
      $('sliderCompare').hidden = next !== 'slider';
      $('sideCompare').hidden = next !== 'side';
      const mount = next === 'slider' ? $('sliderFootControlsMount') : $('sideControlsMount');
      mount.append($('compareControls'));
      $('sideControlsMount').hidden = next !== 'side';
      $('sliderMode').classList.toggle('active', next === 'slider');
      $('sideMode').classList.toggle('active', next === 'side');
      $('sliderMode').setAttribute('aria-pressed', String(next === 'slider'));
      $('sideMode').setAttribute('aria-pressed', String(next === 'side'));
      requestAnimationFrame(renderView);
    }
    function resetView() {
      stopViewAnimation();
      zoom = targetZoom = 1;
      panX = panY = targetPanX = targetPanY = 0;
      setSplit(50);
      renderView();
    }
    $('sliderMode').addEventListener('click', () => setMode('slider'));
    $('sideMode').addEventListener('click', () => setMode('side'));
    $('zoomIn').addEventListener('click', () => setZoom(targetZoom + .25));
    $('zoomOut').addEventListener('click', () => setZoom(targetZoom - .25));
    $('zoomFit').addEventListener('click', resetView);
    // The visible divider is also keyboard-operable; no secondary scrubber needed.
    const grip = $('splitGrip');
    grip.addEventListener('keydown', e => {
      let next = splitPercent;
      switch (e.key) {
        case 'ArrowLeft': case 'ArrowDown': next -= 1; break;
        case 'ArrowRight': case 'ArrowUp': next += 1; break;
        case 'PageDown': next -= 10; break;
        case 'PageUp': next += 10; break;
        case 'Home': next = 0; break;
        case 'End': next = 100; break;
        default: return;
      }
      e.preventDefault();
      setSplit(next);
    });
    function splitAtX(clientX) {
      const b = $('sliderViewport').getBoundingClientRect();
      setSplit(Math.round((clientX - b.left) / b.width * 100));
    }
    grip.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.stopPropagation(); grip.setPointerCapture(e.pointerId); grip.classList.add('is-dragging'); splitAtX(e.clientX);
    });
    grip.addEventListener('pointermove', e => {
      if (grip.hasPointerCapture(e.pointerId)) splitAtX(e.clientX);
    });
    const endDividerDrag = () => grip.classList.remove('is-dragging');
    grip.addEventListener('pointerup', endDividerDrag);
    grip.addEventListener('pointercancel', endDividerDrag);
    grip.addEventListener('lostpointercapture', endDividerDrag);
    // Drag to pan at >100%; hovering the image activates wheel zoom.
    for (const view of panViewports) {
      let moving = false, lastX = 0, lastY = 0;
      view.addEventListener('pointerdown', e => {
        if (zoom <= 1 || (e.pointerType === 'mouse' && e.button !== 0) || e.target.closest('#splitGrip')) return;
        // Direct dragging takes over from easing without any catch-up or jump.
        stopViewAnimation();
        targetZoom = zoom;
        targetPanX = panX; targetPanY = panY;
        moving = true; lastX = e.clientX; lastY = e.clientY;
        view.setPointerCapture(e.pointerId); view.classList.add('is-panning');
      });
      view.addEventListener('pointermove', e => {
        if (!moving || !view.hasPointerCapture(e.pointerId)) return;
        panX += (e.clientX - lastX) / view.clientWidth;
        panY += (e.clientY - lastY) / view.clientHeight;
        lastX = e.clientX; lastY = e.clientY;
        renderView();
        targetPanX = panX; targetPanY = panY;
      });
      const release = () => { moving = false; view.classList.remove('is-panning'); };
      view.addEventListener('pointerup', release);
      view.addEventListener('pointercancel', release);
      view.addEventListener('lostpointercapture', release);
      view.addEventListener('wheel', e => {
        if (!e.deltaY) return;
        // Always consume the wheel while over the image, including at 100% and 600%.
        // Otherwise the page jumps when zoom reaches either limit.
        e.preventDefault();
        const r = view.getBoundingClientRect();
        const pixels = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1);
        setZoom(targetZoom * Math.exp(-pixels * 0.0012), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      }, { passive: false });
    }
    window.addEventListener('resize', renderView);


    // --- File sizes, optimization controls and popover ---
