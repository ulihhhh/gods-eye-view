/*
 * Runs in the ISOLATED content-script world on *.liveuamap.com.
 * Bridges page -> extension: receives the map state from reader.js (MAIN world)
 * via window.postMessage and forwards it to the service worker, which does the
 * actual cross-origin POST to the local dev server. Also paints a tiny status
 * chip so you can see the bridge is alive.
 */
(function () {
  let chip;
  function setStatus(text, ok) {
    if (!chip) {
      chip = document.createElement('div');
      chip.style.cssText =
        'position:fixed;z-index:2147483647;left:8px;bottom:8px;font:11px/1.4 monospace;' +
        'padding:4px 8px;border-radius:4px;color:#fff;background:#222;opacity:.85;pointer-events:none';
      (document.body || document.documentElement).appendChild(chip);
    }
    chip.textContent = `GEV bridge · ${text}`;
    chip.style.background = ok === false ? '#7a1f1f' : ok === true ? '#1f5a2f' : '#333';
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__gevLiveuamapBridge !== 1) return;
    const payload = e.data.payload;
    chrome.runtime.sendMessage({ type: 'gev-liveuamap-ingest', payload }, (reply) => {
      if (chrome.runtime.lastError || !reply) {
        setStatus('dev server unreachable', false);
        return;
      }
      if (reply.error) {
        setStatus(reply.error, false);
        return;
      }
      const kept = reply.kept ? ' (kept previous)' : '';
      setStatus(`${payload.region}: ${reply.events} events, ${reply.fields} fields${kept}`, true);
    });
  });

  setStatus('waiting for map data…');
})();
