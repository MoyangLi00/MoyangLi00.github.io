/**
 * GS rendering: input vs rendered comparison.
 * Paths: ./static/videos/gs_rendering/<scene>/input_video.mp4
 *        ./static/videos/gs_rendering/<scene>/rendered_images.mp4
 * Override filenames with data-input-file / data-rendered-file if needed.
 *
 * Use H.264 + AAC (or video-only H.264) in MP4 for web; MPEG-4 Part 2 (mp4v)
 * often fails in Chrome/Safari (MediaError code 4).
 */
(function () {
  var GS_RENDERING_BASE = './static/videos/gs_rendering/';

  function withCacheBust(url, bust) {
    if (!bust) return url;
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    return url + sep + 'cb=' + encodeURIComponent(String(bust));
  }

  function setSources(root) {
    // Avoid stale video caching after re-encoding.
    var cacheBuster = root.getAttribute('data-cache-bust') || Date.now();

    var rendered = root.querySelector('[data-role="rendered"]');
    var input = root.querySelector('[data-role="input"]');
    if (!rendered || !input) return;

    // Reset previous error message on scene switch.
    var err = root.querySelector('.video-compare__error');
    if (err) err.hidden = true;

    var explicitIn = root.getAttribute('data-input-src');
    var explicitRen = root.getAttribute('data-rendered-src');
    if (explicitIn && explicitRen) {
      input.src = withCacheBust(explicitIn, cacheBuster);
      rendered.src = withCacheBust(explicitRen, cacheBuster);
      return;
    }

    var scene = root.getAttribute('data-scene');
    if (!scene) return;

    var inputFile = root.getAttribute('data-input-file') || 'input_video.mp4';
    var renderedFile = root.getAttribute('data-rendered-file') || 'rendered_images.mp4';
    var base = GS_RENDERING_BASE + scene + '/';
    rendered.src = withCacheBust(base + renderedFile, cacheBuster);
    input.src = withCacheBust(base + inputFile, cacheBuster);
  }

  // Expose a small helper so inline scene tabs can swap the active scene
  // without creating another video-compare DOM block.
  window.__droidwVideoCompareSetScene = function (root, scene) {
    if (!root) return;
    root.setAttribute('data-scene', scene);
    root.setAttribute('data-cache-bust', Date.now());
    setSources(root);
  };

  function initVideoCompare(root) {
    setSources(root);

    var rendered = root.querySelector('[data-role="rendered"]');
    var input = root.querySelector('[data-role="input"]');
    var handle = root.querySelector('.video-compare__handle');
    if (!rendered || !input || !handle) return;

    function showLoadError(which, video) {
      var el = root.querySelector('.video-compare__error');
      if (!el) return;
      el.hidden = false;
      var parts = [];
      if (window.location.protocol === 'file:') {
        parts.push('Local pages are opened as file:// — use a local server (e.g. python3 -m http.server) and open http://localhost:…/droid-w/ instead.');
      }
      var code = video && video.error ? video.error.code : 0;
      var src = (video && (video.currentSrc || video.src)) || '';
      parts.push('Could not load ' + which + '.');
      if (src) parts.push('URL: ' + src);
      if (code === 4) {
        parts.push(
          'Browser error 4 (unsupported format or codec). Re-encode to H.264 video + AAC audio for MP4 (e.g. ffmpeg -i in.mp4 -c:v libx264 -crf 20 -c:a aac -movflags +faststart out.mp4).'
        );
      } else if (code) {
        parts.push('Media error code ' + code + '.');
      } else {
        parts.push('Check that the file exists and the path is correct.');
      }
      el.textContent = parts.join(' ');
    }

    rendered.addEventListener('error', function () {
      showLoadError('rendered video', rendered);
    });
    input.addEventListener('error', function () {
      showLoadError('input video', input);
    });

    function setSplit(pct) {
      var clamped = Math.max(6, Math.min(94, pct));
      root.style.setProperty('--split', clamped + '%');
    }

    function splitFromClientX(clientX) {
      var rect = root.getBoundingClientRect();
      if (rect.width <= 0) return;
      var x = clientX - rect.left;
      setSplit((x / rect.width) * 100);
    }

    var dragging = false;

    function onMove(e) {
      if (!dragging) return;
      if (e.cancelable && e.type === 'touchmove') e.preventDefault();
      var cx =
        e.clientX !== undefined
          ? e.clientX
          : e.touches && e.touches[0]
            ? e.touches[0].clientX
            : 0;
      splitFromClientX(cx);
    }

    function endDrag() {
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', endDrag);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', endDrag);
    }

    function startDrag(e) {
      dragging = true;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', endDrag);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', endDrag);
      if (e.type === 'mousedown') e.preventDefault();
    }

    handle.addEventListener('mousedown', startDrag);
    handle.addEventListener('touchstart', startDrag, { passive: true });

    /** Master clock: video with controls (rendered). Keep input locked to it.
     * Some videos (especially high-bitrate / high-profile ones) can "stutter"
     * if we repeatedly set `input.currentTime` every frame.
     * Throttle sync updates to reduce re-decode churn.
     */
    var syncRafId = null;
    // Larger throttle + eps reduces how often we force `input.currentTime`,
    // which can trigger re-decode and visible stutter in some encoded MP4s.
    var SYNC_EPS = 0.08; // allow more drift without frequent seeks
    var SYNC_THROTTLE_MS = 300;
    var lastSyncMs = 0;

    function clampTimeToBoth(t) {
      var dr = rendered.duration;
      var di = input.duration;
      if (isFinite(dr) && isFinite(di)) {
        var end = Math.min(dr, di) - 0.02;
        if (t > end) t = Math.max(0, end);
      }
      return t;
    }

    function syncInputToRendered() {
      var now = Date.now();
      if (now - lastSyncMs < SYNC_THROTTLE_MS) return;
      lastSyncMs = now;
      if (rendered.seeking) return;
      // If input hasn't buffered enough yet, forcing currentTime can stall.
      // HAVE_CURRENT_DATA = 2
      if (input.readyState < 2) return;
      if (input.seeking) return;
      var t = clampTimeToBoth(rendered.currentTime);
      if (!isFinite(t) || t < 0) return;
      if (Math.abs(input.currentTime - t) > SYNC_EPS) {
        input.currentTime = t;
      }
    }

    function syncLoop() {
      syncInputToRendered();
      if (!rendered.paused && !rendered.ended) {
        syncRafId = requestAnimationFrame(syncLoop);
      } else {
        syncRafId = null;
      }
    }

    function startSyncLoop() {
      if (syncRafId != null) return;
      syncRafId = requestAnimationFrame(syncLoop);
    }

    function stopSyncLoop() {
      if (syncRafId != null) {
        cancelAnimationFrame(syncRafId);
        syncRafId = null;
      }
    }

    // When the user seeks (progress bar), avoid forcing `input.currentTime`
    // mid-flight. Instead, pause during `seeking`, then set + wait for `input`
    // to finish seeking on `seeked` before resuming sync/play.
    var seekToken = 0;
    var inputSeekedHandler = null;

    function syncAfterInputSeek(token) {
      if (token !== seekToken) return; // superseded by a newer seek
      syncInputToRendered();
      if (!rendered.paused && !rendered.ended) {
        input.playbackRate = rendered.playbackRate;
        input.play().catch(function () {});
        startSyncLoop();
      } else {
        try { input.pause(); } catch (e) {}
        stopSyncLoop();
      }
    }

    function queueInputSeekedOnce(token) {
      if (inputSeekedHandler) {
        try { input.removeEventListener('seeked', inputSeekedHandler); } catch (e) {}
      }
      inputSeekedHandler = function () {
        syncAfterInputSeek(token);
      };
      input.addEventListener('seeked', inputSeekedHandler, { once: true });
    }

    rendered.addEventListener('seeking', function () {
      stopSyncLoop();
      try { input.pause(); } catch (e) {}
    });
    rendered.addEventListener('seeked', function () {
      var t = clampTimeToBoth(rendered.currentTime);
      if (!isFinite(t) || t < 0) return;
      seekToken++;
      var token = seekToken;
      queueInputSeekedOnce(token);
      try {
        input.currentTime = t;
      } catch (e) {}
    });
    rendered.addEventListener('play', function () {
      input.playbackRate = rendered.playbackRate;
      input.play().catch(function () {});
      syncInputToRendered();
    });
    rendered.addEventListener('playing', function () {
      syncInputToRendered();
      startSyncLoop();
    });
    rendered.addEventListener('pause', function () {
      stopSyncLoop();
      input.pause();
      syncInputToRendered();
    });
    rendered.addEventListener('ratechange', function () {
      input.playbackRate = rendered.playbackRate;
    });
    rendered.addEventListener('timeupdate', function () {
      syncInputToRendered();
    });
    rendered.addEventListener('ended', function () {
      stopSyncLoop();
    });

    function onBothReady() {
      // Wait a bit more than metadata before first sync/playback coupling.
      // HAVE_CURRENT_DATA = 2
      if (rendered.readyState >= 2 && input.readyState >= 2) {
        input.playbackRate = rendered.playbackRate;
        syncInputToRendered();
      }
    }
    rendered.addEventListener('loadedmetadata', onBothReady);
    input.addEventListener('loadedmetadata', onBothReady);
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.video-compare').forEach(function (el) {
      initVideoCompare(el);
    });
    // Let other inline scripts know all compare instances are initialized.
    window.__droidwVideoCompareInitialized = true;
  });
})();
