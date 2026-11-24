/* Private gate for apps whose content is published encrypted.

   The public copy of a gated app holds a connect page, its icons, a service worker and
   two files made by build/publish_public.py: private.bin (the app's own files, gzipped and
   encrypted with AES-GCM) and private.json (the bundle's version). The owner's key, saved in
   this browser, decrypts the bundle into the browser's cache, and the service worker
   (private-sw.js) serves the app from there, also offline.

   The key arrives once per device through an unlock link (…/Apps/#key=…): the part after #
   is never sent to any server. It can also be pasted on the connect page.

   Modes (data-mode on the script tag):
   - gate (default): the connect page.
   - refresh: added by the service worker to the cached app page. Fetches a newer bundle in
     the background and offers a reload when one was installed. */
(function () {
  const me = document.currentScript;
  const APP = me.dataset.app;
  const MODE = me.dataset.mode || 'gate';
  const BASE = new URL('../', me.src).pathname;          // e.g. /Apps/
  const DIR = BASE + APP + '/';
  const KEY = 'appsKey.v1';
  const CACHE = 'private-' + APP;
  const STATE = DIR + '.private-state.json';

  const readKey = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
  const saveKey = (k) => localStorage.setItem(KEY, k.trim());
  const fromB64 = (s) => {
    const t = s.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
  };

  // A key in the address (#key=…) is saved, then removed from the address bar.
  const m = /[#&]key=([A-Za-z0-9_-]{40,})/.exec(location.hash);
  if (m) {
    try { saveKey(m[1]); } catch (e) { /* storage blocked: the form explains */ }
    history.replaceState(null, '', location.pathname + location.search);
  }

  class KeyError extends Error {}

  // Install the newest bundle into the cache. Returns the number of files written (0 if current).
  async function sync(progress) {
    const meta = await fetch(DIR + 'private.json', { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error('The app bundle is missing (' + r.status + ').');
      return r.json();
    });
    const cache = await caches.open(CACHE);
    const saved = await cache.match(STATE).then((r) => (r ? r.json() : {})).catch(() => ({}));
    if (saved.version === meta.version && (await cache.match(DIR + 'index.html'))) return 0;
    if (progress) progress('Downloading…');
    const bin = new Uint8Array(await fetch(DIR + 'private.bin?v=' + meta.version, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error('The app bundle is missing (' + r.status + ').');
      return r.arrayBuffer();
    }));
    let plain;
    try {
      const key = await crypto.subtle.importKey('raw', fromB64(readKey()), 'AES-GCM', false, ['decrypt']);
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bin.slice(0, 12) }, key, bin.slice(12));
    } catch (e) {
      throw new KeyError('This key does not open the app.');
    }
    if (progress) progress('Unpacking…');
    const bundle = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
    const paths = Object.keys(bundle.files);
    for (const p of paths) {
      const f = bundle.files[p];
      await cache.put(BASE + p, new Response(fromB64(f.data), { headers: { 'Content-Type': f.type } }));
    }
    for (const p of saved.files || []) if (!paths.includes(p)) await cache.delete(BASE + p);
    await cache.put(STATE, new Response(JSON.stringify({ version: meta.version, files: paths }),
      { headers: { 'Content-Type': 'application/json' } }));
    return paths.length;
  }

  if (MODE === 'refresh') {
    if (!readKey()) return;
    sync().then((n) => {
      if (!n) return;
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;background:#1c1a17;color:#f2f0ea;'
        + 'font:13px/1.4 system-ui,sans-serif;padding:8px 10px;border:1px solid #6a6259;display:flex;gap:10px;align-items:center';
      bar.innerHTML = '<span>A newer version is ready.</span>';
      const b = document.createElement('button');
      b.textContent = 'Reload';
      b.style.cssText = 'font:inherit;background:#f2f0ea;color:#1c1a17;border:0;padding:3px 9px;cursor:pointer';
      b.onclick = () => location.reload();
      bar.appendChild(b);
      document.body.appendChild(bar);
    }).catch(() => { /* offline: keep the cached copy */ });
    return;
  }

  // Gate mode: the connect page.
  const $ = (id) => document.getElementById(id);
  const say = (text) => { $('gate-status').textContent = text; };
  const showForm = (message) => {
    $('gate-form').hidden = false;
    say(message || '');
    $('gate-key').focus();
  };

  async function open() {
    $('gate-form').hidden = true;
    say('Opening the app…');
    try {
      const n = await sync(say);
      await navigator.serviceWorker.ready;
      const tries = Number(sessionStorage.getItem('privateGate.reloads') || 0);
      if (tries >= 2 && !n) {
        sessionStorage.removeItem('privateGate.reloads');
        say('The app is ready, but this browser does not let it run from its cache (a private window, or site data blocked).');
        return;
      }
      sessionStorage.setItem('privateGate.reloads', String(tries + 1));
      location.reload();
    } catch (e) {
      if (e instanceof KeyError) showForm(e.message + ' Paste the key again or open the unlock link.');
      else { say((e.message || 'Something went wrong.') + ' Check the connection and try again.'); $('gate-retry').hidden = false; }
    }
  }

  function start() {
    if (!('serviceWorker' in navigator) || !('caches' in window) || !('DecompressionStream' in window)) {
      say('This browser cannot store the app for offline use, so it cannot open here.');
      return;
    }
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
    $('gate-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const k = $('gate-key').value.replace(/^.*#key=/, '').trim();
      if (!k) return;
      try { saveKey(k); } catch (e) { say('This browser does not allow saving the key.'); return; }
      $('gate-key').value = '';
      open();
    });
    $('gate-retry').addEventListener('click', () => { $('gate-retry').hidden = true; open(); });
    if (readKey()) open(); else showForm();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
