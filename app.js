/* LWH One Source Inbound Scan
 * Local-first: every scan saves on this device first (IndexedDB + localStorage mirror).
 * When there's signal and a sync code is set, changes push to Supabase (LWH Companion)
 * and other devices' loads pull down, so every device sees the same loads.
 */
(function () {
  'use strict';

  const APP_VERSION = '1.1.0';
  const SB_URL = 'https://tjivcqxnkftujceumdtx.supabase.co';
  const SB_KEY = 'sb_publishable_PYlWSW6-Gi-QZl91IXUq0Q_W5mO3sDT';
  const DB_NAME = 'lwh-os-inbound';
  const STORE = 'loads';
  const LS_KEY = 'lwh-os-inbound-mirror';
  const SET_KEY = 'lwh-os-inbound-settings';
  const QTY_MAX = 9999;
  const SYNC_EVERY_MS = 20000;

  // ---------- state ----------
  let loads = [];
  let current = null;
  let editingId = null;
  let step = 'pallet';
  let pending = { palletId: '', pgid: '' };
  let lastAddedTs = null;
  let settings = loadSettings();
  const sync = { busy: false, timer: null, lastOk: null, error: null };

  const $ = (id) => document.getElementById(id);
  const els = {
    back: $('backBtn'), netPill: $('netPill'), offlinePill: $('offlinePill'), syncPill: $('syncPill'),
    updateBar: $('updateBar'), reloadBtn: $('reloadBtn'),
    vHome: $('viewHome'), vForm: $('viewForm'), vScan: $('viewScan'),
    newLoad: $('newLoadBtn'), loadList: $('loadList'),
    exportAll: $('exportAllBtn'), backup: $('backupBtn'), restore: $('restoreFile'), storageInfo: $('storageInfo'),
    syncCode: $('syncCode'), deviceName: $('deviceName'), saveSync: $('saveSyncBtn'), syncNow: $('syncNowBtn'), syncStatus: $('syncStatus'),
    form: $('loadForm'), formTitle: $('formTitle'), formMsg: $('formMsg'), formCancel: $('formCancel'), formSave: $('formSave'),
    fLoad: $('fLoad'), fCarrier: $('fCarrier'), fItem: $('fItem'), fBin: $('fBin'),
    hLoad: $('hLoad'), hCarrier: $('hCarrier'), hItem: $('hItem'), hBin: $('hBin'),
    sPallets: $('sPallets'), sQty: $('sQty'), editHead: $('editHeadBtn'),
    closedBanner: $('closedBanner'), scanBox: $('scanBox'),
    inPallet: $('inPallet'), inPgid: $('inPgid'), inQty: $('inQty'),
    scanMsg: $('scanMsg'), clearRow: $('clearRowBtn'),
    print: $('printBtn'), csv: $('csvBtn'), closeLoad: $('closeLoadBtn'), deleteLoad: $('deleteLoadBtn'),
    rows: $('palletRows'), emptyPallets: $('emptyPallets'),
    printArea: $('printArea'), ver: $('verText'),
    camOverlay: $('camOverlay'), camTitle: $('camTitle'), camClose: $('camClose'), camHint: $('camHint')
  };

  // ---------- settings ----------
  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SET_KEY) || '{}'); } catch (e) { /* ignore */ }
    if (!s.device) s.device = 'Device ' + Math.random().toString(36).slice(2, 6).toUpperCase();
    return Object.assign({ code: '', since: null }, s);
  }
  function saveSettings() { try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ } }

  // ---------- storage ----------
  let dbp = null;
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB not available'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function idbAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  }
  async function idbPut(load) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(load);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  function mirror() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(loads)); } catch (e) { /* storage full or blocked */ }
  }
  // Write to device storage without changing timestamps (used by sync merges)
  async function persist(load) {
    mirror();
    try { await idbPut(load); }
    catch (e) { setMsg('Could not save to device storage. Export a backup now.', 'err'); console.error(e); }
  }
  // A local edit: stamp it, store it, and queue a sync
  async function saveLoad(load) {
    load.updatedAt = new Date().toISOString();
    await persist(load);
    scheduleSync(1200);
  }
  async function dropLocal(id) {
    loads = loads.filter((l) => l.id !== id);
    mirror();
    try { await idbDelete(id); } catch (e) { console.error(e); }
  }
  async function loadAll() {
    let fromIdb = [];
    try { fromIdb = await idbAll(); } catch (e) { console.warn(e); }
    let fromLs = [];
    try { fromLs = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (e) { /* ignore */ }
    const map = new Map();
    [...fromLs, ...fromIdb].forEach((l) => {
      const ex = map.get(l.id);
      if (!ex || (l.updatedAt || '') >= (ex.updatedAt || '')) map.set(l.id, l);
    });
    loads = [...map.values()];
    // Loads made before sync existed (v1.0) get queued in full for upload
    loads.forEach((l) => {
      if (!l._syncInit) {
        l._syncInit = true;
        l._headDirty = true;
        l._dirtyKeys = l.pallets.map((p) => norm(p.palletId));
        l._removedKeys = [];
      }
      l._dirtyKeys = l._dirtyKeys || [];
      l._removedKeys = l._removedKeys || [];
    });
    for (const l of loads) { try { await idbPut(l); } catch (e) { /* ignore */ } }
    mirror();
  }

  // ---------- helpers ----------
  const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const clean = (v) => String(v || '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const totalQty = (l) => l.pallets.reduce((a, p) => a + (Number(p.qty) || 0), 0);
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDate = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtDT = (iso) => fmtDate(iso) + ' ' + fmtTime(iso);
  const norm = (s) => clean(s).toUpperCase();
  const live = () => loads.filter((l) => !l.deleted);
  const pendingCount = (l) => (l._headDirty ? 1 : 0) + l._dirtyKeys.length + l._removedKeys.length;
  const addKey = (arr, k) => { if (!arr.includes(k)) arr.push(k); };
  const dropKey = (arr, k) => { const i = arr.indexOf(k); if (i >= 0) arr.splice(i, 1); };

  function findPalletElsewhere(palletId) {
    const key = norm(palletId);
    for (const l of live()) {
      if (current && l.id === current.id) continue;
      if (l.pallets.some((p) => norm(p.palletId) === key)) return l;
    }
    return null;
  }

  // ---------- feedback ----------
  let actx = null;
  function beep(ok) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(); const g = actx.createGain();
      o.type = ok ? 'sine' : 'square';
      o.frequency.value = ok ? 1250 : 220;
      g.gain.value = 0.12;
      o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + (ok ? 0.09 : 0.35));
    } catch (e) { /* no audio */ }
    if (navigator.vibrate) navigator.vibrate(ok ? 40 : [120, 60, 120]);
  }
  function flash(ok) {
    els.scanBox.classList.remove('flash-ok', 'flash-err');
    void els.scanBox.offsetWidth;
    els.scanBox.classList.add(ok ? 'flash-ok' : 'flash-err');
  }
  function setMsg(text, kind) {
    els.scanMsg.textContent = text;
    els.scanMsg.className = 'msg scan-msg' + (kind ? ' ' + kind : '');
  }

  // ---------- views ----------
  let view = 'home';
  function show(v) {
    view = v;
    els.vHome.hidden = v !== 'home';
    els.vForm.hidden = v !== 'form';
    els.vScan.hidden = v !== 'scan';
    els.back.hidden = v === 'home';
    window.scrollTo(0, 0);
  }

  function renderHomeList() {
    const sorted = live().sort((a, b) => {
      if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
    if (!sorted.length) {
      els.loadList.innerHTML = '<p class="empty">No loads yet. Tap Start new load when a One Source trailer is ready to unload.</p>';
    } else {
      els.loadList.innerHTML = sorted.map((l) => {
        const waiting = pendingCount(l) ? ' | <span class="li-wait">waiting to sync</span>' : '';
        const from = l.device && l.device !== settings.device ? ` | from ${esc(l.device)}` : '';
        return `
        <button class="load-item ${l.status === 'closed' ? 'closed' : ''}" data-id="${esc(l.id)}">
          <div>
            <div class="li-title">${esc(l.loadNo)}<span class="status ${l.status === 'closed' ? 'closed' : ''}">${l.status === 'closed' ? 'Closed' : 'Open'}</span></div>
            <div class="li-sub">${esc(l.carrier)} | Item ${esc(l.itemNo)} | Bin ${esc(l.binClass)} | ${esc(fmtDT(l.createdAt))}${from}${waiting}</div>
          </div>
          <div class="li-count"><strong>${l.pallets.length}</strong>pallets, ${totalQty(l)} qty</div>
        </button>`;
      }).join('');
    }
    const pallets = live().reduce((a, l) => a + l.pallets.length, 0);
    els.storageInfo.textContent = `${live().length} load(s), ${pallets} pallet(s) on this device.`;
  }
  function renderHome() {
    current = null;
    renderHomeList();
    els.syncCode.value = settings.code;
    els.deviceName.value = settings.device;
    show('home');
  }

  function openForm(load) {
    editingId = load ? load.id : null;
    els.formTitle.textContent = load ? 'Edit load info' : 'New load';
    els.formSave.textContent = load ? 'Save changes' : 'Save and start scanning';
    els.fLoad.value = load ? load.loadNo : '';
    els.fCarrier.value = load ? load.carrier : '';
    els.fItem.value = load ? load.itemNo : '';
    els.fBin.value = load ? load.binClass : '';
    els.formMsg.textContent = '';
    show('form');
    setTimeout(() => els.fLoad.focus(), 50);
  }

  function openScan(load) {
    current = load;
    resetPending();
    renderScan();
    show('scan');
    if (current.status === 'open') setTimeout(() => els.inPallet.focus(), 60);
  }

  function renderScan() {
    const l = current;
    els.hLoad.textContent = l.loadNo;
    els.hCarrier.textContent = l.carrier;
    els.hItem.textContent = l.itemNo;
    els.hBin.textContent = l.binClass;
    els.sPallets.textContent = l.pallets.length;
    els.sQty.textContent = totalQty(l);
    const closed = l.status === 'closed';
    els.closedBanner.hidden = !closed;
    els.scanBox.hidden = closed;
    els.closeLoad.textContent = closed ? 'Reopen load' : 'Close load';
    els.emptyPallets.hidden = l.pallets.length > 0;
    const n = l.pallets.length;
    els.rows.innerHTML = l.pallets.slice().reverse().map((p, i) => `
      <tr class="${p.scannedAt === lastAddedTs ? 'fresh' : ''}">
        <td>${n - i}</td><td>${esc(p.palletId)}</td><td>${esc(p.pgid)}</td>
        <td class="num">${esc(p.qty)}</td><td>${esc(fmtTime(p.scannedAt))}</td>
        <td>${closed ? '' : `<button class="del-btn" data-pid="${esc(p.palletId)}">Remove</button>`}</td>
      </tr>`).join('');
    setStepUI();
  }

  // ---------- scan loop ----------
  function resetPending() {
    pending = { palletId: '', pgid: '' };
    els.inPallet.value = ''; els.inPgid.value = ''; els.inQty.value = '';
    step = 'pallet';
    setStepUI();
  }
  function setStepUI() {
    const order = ['pallet', 'pgid', 'qty'];
    document.querySelectorAll('.scan-field').forEach((f) => {
      const s = f.dataset.step;
      f.classList.toggle('active', s === step);
      f.classList.toggle('done', order.indexOf(s) < order.indexOf(step));
    });
  }
  function goStep(s) {
    step = s;
    setStepUI();
    ({ pallet: els.inPallet, pgid: els.inPgid, qty: els.inQty })[s].focus();
  }

  function handlePallet() {
    const v = clean(els.inPallet.value);
    els.inPallet.value = v;
    if (!v) return;
    if (current.pallets.some((p) => norm(p.palletId) === norm(v))) {
      beep(false); flash(false);
      setMsg(`Pallet ID ${v} is already on this load. Scan the next pallet.`, 'err');
      els.inPallet.value = ''; return goStep('pallet');
    }
    const other = findPalletElsewhere(v);
    if (other) {
      beep(false); flash(false);
      setMsg(`Pallet ID ${v} was already scanned on load ${other.loadNo}. Check the label before continuing.`, 'err');
      els.inPallet.value = ''; return goStep('pallet');
    }
    pending.palletId = v;
    setMsg('Now scan the PGID.');
    goStep('pgid');
  }

  function handlePgid() {
    const v = clean(els.inPgid.value);
    els.inPgid.value = v;
    if (!v) return;
    if (norm(v) === norm(pending.palletId)) {
      beep(false); flash(false);
      setMsg('That matches the Pallet ID. Scan the PGID barcode.', 'err');
      els.inPgid.value = ''; return goStep('pgid');
    }
    pending.pgid = v;
    setMsg('Now scan the QTY.');
    goStep('qty');
  }

  async function handleQty() {
    const v = clean(els.inQty.value);
    els.inQty.value = v;
    if (!v) return;
    if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > QTY_MAX) {
      beep(false); flash(false);
      setMsg(`QTY must be a whole number from 1 to ${QTY_MAX}. "${v}" looks like a different barcode. Scan the QTY again.`, 'err');
      els.inQty.value = ''; return goStep('qty');
    }
    if (!pending.palletId || !pending.pgid) { resetPending(); return goStep('pallet'); }
    const p = { palletId: pending.palletId, pgid: pending.pgid, qty: Number(v), scannedAt: new Date().toISOString(), device: settings.device };
    current.pallets.push(p);
    const k = norm(p.palletId);
    addKey(current._dirtyKeys, k);
    dropKey(current._removedKeys, k);
    lastAddedTs = p.scannedAt;
    // Update the screen and refocus first so the next scan can't land in the wrong field,
    // then write to storage.
    const load = current;
    beep(true); flash(true);
    resetPending();
    renderScan();
    setMsg(`Saved pallet ${load.pallets.length}: ${p.palletId}, qty ${p.qty}. Scan the next Pallet ID.`, 'ok');
    goStep('pallet');
    await saveLoad(load);
  }

  function bindScanInput(input, handler, s) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.key === 'Tab' && e.shiftKey) return;
        e.preventDefault();
        handler();
      }
    });
    input.addEventListener('focus', () => {
      if (s === 'pgid' && !pending.palletId) return goStep('pallet');
      if (s === 'qty' && !pending.palletId) return goStep('pallet');
      if (s === 'qty' && !pending.pgid) return goStep('pgid');
      step = s; setStepUI();
    });
  }

  // ---------- form ----------
  async function submitForm(e) {
    e.preventDefault();
    const vals = { loadNo: clean(els.fLoad.value), carrier: clean(els.fCarrier.value), itemNo: clean(els.fItem.value), binClass: clean(els.fBin.value) };
    const missing = [['loadNo', 'Load number or BOL', els.fLoad], ['carrier', 'Carrier name', els.fCarrier], ['itemNo', 'Item number', els.fItem], ['binClass', 'Bin class', els.fBin]].find(([k]) => !vals[k]);
    if (missing) { els.formMsg.className = 'msg err'; els.formMsg.textContent = `${missing[1]} is required.`; missing[2].focus(); return; }
    const dupe = live().find((l) => l.id !== editingId && norm(l.loadNo) === norm(vals.loadNo));
    if (dupe && !confirm(`Load ${dupe.loadNo} already exists${dupe.device && dupe.device !== settings.device ? ' (started on ' + dupe.device + ')' : ''}. Create another load with the same number anyway?\n\nTap Cancel to open the existing load instead.`)) {
      return openScan(dupe);
    }
    if (editingId) {
      const l = loads.find((x) => x.id === editingId);
      Object.assign(l, vals);
      l._headDirty = true;
      await saveLoad(l);
      openScan(l);
    } else {
      const l = { id: uid(), ...vals, status: 'open', createdAt: new Date().toISOString(), updatedAt: '', pallets: [],
        device: settings.device, appVersion: APP_VERSION, _syncInit: true, _headDirty: true, _dirtyKeys: [], _removedKeys: [] };
      loads.push(l);
      await saveLoad(l);
      openScan(l);
    }
  }
  [els.fLoad, els.fCarrier, els.fItem].forEach((inp, i, arr) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); ([...arr, els.fBin])[i + 1].focus(); }
    });
  });

  // ---------- printing ----------
  function barcodeSvg(value, opts) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    try {
      JsBarcode(svg, value, Object.assign({
        format: 'CODE128', width: 1.6, height: 44, displayValue: true,
        fontSize: 14, textMargin: 2, margin: 4, marginLeft: 20, marginRight: 20, font: 'Arial'
      }, opts || {}));
      return svg.outerHTML;
    } catch (e) {
      return `<strong>${esc(value)}</strong> (barcode could not be drawn)`;
    }
  }
  function buildSheet(l) {
    const rows = l.pallets.map((p, i) => `
      <tr>
        <td class="n">${i + 1}</td>
        <td class="bc">${barcodeSvg(p.palletId)}</td>
        <td>${esc(p.pgid)}</td>
        <td class="q">${esc(p.qty)}</td>
        <td class="chk"><span class="ps-box"></span></td>
      </tr>`).join('');
    return `
      <section class="ps-sheet">
        <div class="ps-head">
          <div class="ps-title"><h1>One Source inbound scan sheet</h1><span class="co">Logistics Warehouse, Inc.</span></div>
          <div class="ps-grid">
            <div><span>Load / BOL</span><strong>${esc(l.loadNo)}</strong></div>
            <div><span>Carrier</span><strong>${esc(l.carrier)}</strong></div>
            <div><span>Item number</span><strong>${esc(l.itemNo)}</strong></div>
            <div><span>Bin class</span><strong>${esc(l.binClass)}</strong></div>
            <div><span>Received</span><strong>${esc(fmtDT(l.createdAt))}</strong></div>
            <div><span>Pallets</span><strong>${l.pallets.length}</strong></div>
            <div><span>Total qty</span><strong>${totalQty(l)}</strong></div>
            <div><span>Printed</span><strong>${esc(fmtDT(new Date().toISOString()))}</strong></div>
          </div>
          <div class="ps-load-bc">${barcodeSvg(l.loadNo, { height: 34, fontSize: 12 })}</div>
        </div>
        <table class="ps-table">
          <thead><tr><th>#</th><th>Pallet ID (scan into WMS)</th><th>PGID</th><th style="text-align:right">QTY</th><th>In WMS</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5">No pallets scanned.</td></tr>'}</tbody>
        </table>
        <div class="ps-foot">
          <div>Unloaded by</div><div>Date</div>
          <div>Entered in WMS by</div><div>Date</div>
        </div>
      </section>`;
  }
  function printLoad(l) {
    if (!l.pallets.length && !confirm('This load has no pallets yet. Print anyway?')) return;
    els.printArea.innerHTML = buildSheet(l);
    setTimeout(() => window.print(), 100);
  }

  // ---------- export / backup ----------
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function toCsv(list) {
    const head = ['Load_BOL', 'Carrier', 'Item_Number', 'Bin_Class', 'Pallet_ID', 'PGID', 'QTY', 'Scanned_At', 'Scanned_On_Device', 'Load_Created', 'Load_Status'];
    const out = [head.join(',')];
    list.forEach((l) => l.pallets.forEach((p) => {
      out.push([l.loadNo, l.carrier, l.itemNo, l.binClass, p.palletId, p.pgid, p.qty, p.scannedAt, p.device || '', l.createdAt, l.status].map(csvCell).join(','));
    }));
    return out.join('\r\n');
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const safeName = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);

  async function restoreFile(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { return alert('That file is not a valid backup.'); }
    const incoming = Array.isArray(data) ? data : data.loads;
    if (!Array.isArray(incoming)) return alert('That file is not a One Source Inbound backup.');
    let added = 0, merged = 0, palletsAdded = 0;
    for (const inc of incoming) {
      if (!inc || !inc.id || !Array.isArray(inc.pallets) || inc.deleted) continue;
      const ex = loads.find((l) => l.id === inc.id);
      if (!ex) {
        Object.assign(inc, { _syncInit: true, _headDirty: true, _dirtyKeys: inc.pallets.map((p) => norm(p.palletId)), _removedKeys: [] });
        loads.push(inc); await saveLoad(inc); added++; palletsAdded += inc.pallets.length; continue;
      }
      const have = new Set(ex.pallets.map((p) => norm(p.palletId)));
      const extra = inc.pallets.filter((p) => !have.has(norm(p.palletId)));
      if (extra.length) {
        ex.pallets.push(...extra);
        extra.forEach((p) => { const k = norm(p.palletId); addKey(ex._dirtyKeys, k); dropKey(ex._removedKeys, k); });
        ex.pallets.sort((a, b) => a.scannedAt.localeCompare(b.scannedAt));
        palletsAdded += extra.length; merged++;
        await saveLoad(ex);
      }
    }
    alert(`Restore complete: ${added} new load(s), ${merged} load(s) merged, ${palletsAdded} pallet(s) added.`);
    renderHome();
  }

  // ---------- sync ----------
  function scheduleSync(ms) {
    clearTimeout(sync.timer);
    sync.timer = setTimeout(syncNow, ms == null ? 1200 : ms);
    updateSyncUI();
  }

  function buildPayload() {
    const dirty = loads.filter((l) => pendingCount(l) > 0).slice(0, 40);
    const snap = new Map();
    const payload = dirty.map((l) => {
      const keys = new Set(l._dirtyKeys);
      snap.set(l.id, { head: !!l._headDirty, updatedAt: l.updatedAt, keys: [...l._dirtyKeys], removed: [...l._removedKeys] });
      return {
        id: l.id, load_no: l.loadNo, carrier: l.carrier, item_no: l.itemNo, bin_class: l.binClass,
        status: l.status, deleted: !!l.deleted, created_at: l.createdAt, updated_at: l.updatedAt,
        device: l.device || settings.device, head_dirty: !!l._headDirty,
        pallets: l.pallets.filter((p) => keys.has(norm(p.palletId))).map((p) => ({
          pallet_id: p.palletId, pgid: p.pgid, qty: p.qty, scanned_at: p.scannedAt, device: p.device || settings.device
        })),
        removed: [...l._removedKeys]
      };
    });
    return { payload, snap };
  }

  async function mergeRemote(r) {
    let l = loads.find((x) => x.id === r.id);
    const toLocal = (rp) => ({ palletId: rp.pallet_id, pgid: rp.pgid || '', qty: rp.qty, scannedAt: rp.scanned_at, device: rp.device || '' });
    if (!l) {
      if (r.deleted) return false;
      l = {
        id: r.id, loadNo: r.load_no, carrier: r.carrier || '', itemNo: r.item_no || '', binClass: r.bin_class || '',
        status: r.status || 'open', createdAt: r.created_at, updatedAt: r.updated_at, device: r.device || '',
        pallets: (r.pallets || []).filter((p) => !p.deleted).map(toLocal),
        _syncInit: true, _headDirty: false, _dirtyKeys: [], _removedKeys: []
      };
      loads.push(l);
      await persist(l);
      return true;
    }
    if (r.deleted && !l._headDirty) {
      await dropLocal(l.id);
      return true;
    }
    let changed = false;
    if (!l._headDirty) {
      const head = { loadNo: r.load_no, carrier: r.carrier || '', itemNo: r.item_no || '', binClass: r.bin_class || '', status: r.status || 'open' };
      for (const k of Object.keys(head)) if (l[k] !== head[k]) { l[k] = head[k]; changed = true; }
    }
    for (const rp of r.pallets || []) {
      const key = norm(rp.pallet_id);
      const idx = l.pallets.findIndex((p) => norm(p.palletId) === key);
      const dirty = l._dirtyKeys.includes(key);
      if (rp.deleted) {
        if (idx >= 0 && !dirty) { l.pallets.splice(idx, 1); changed = true; }
      } else if (idx < 0) {
        if (!l._removedKeys.includes(key)) { l.pallets.push(toLocal(rp)); changed = true; }
      } else if (!dirty) {
        const p = l.pallets[idx];
        if (p.pgid !== (rp.pgid || '') || Number(p.qty) !== Number(rp.qty)) { Object.assign(p, toLocal(rp)); changed = true; }
      }
    }
    if (changed) {
      l.pallets.sort((a, b) => (a.scannedAt || '').localeCompare(b.scannedAt || ''));
      await persist(l);
    }
    return changed;
  }

  async function syncNow() {
    clearTimeout(sync.timer);
    if (sync.busy) return;
    if (!settings.code) { updateSyncUI(); return; }
    if (!navigator.onLine) { updateSyncUI(); return; }
    sync.busy = true; updateSyncUI();
    let again = false;
    try {
      const { payload, snap } = buildPayload();
      const since = settings.since ? new Date(Date.parse(settings.since) - 120000).toISOString() : null;
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 25000);
      const res = await fetch(SB_URL + '/rest/v1/rpc/os_inbound_sync', {
        method: 'POST', signal: ctrl.signal,
        headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_code: settings.code, p_loads: payload, p_since: since, p_device: settings.device })
      });
      clearTimeout(to);
      if (!res.ok) throw new Error('Server responded ' + res.status);
      const out = await res.json();
      if (!out.ok) {
        sync.error = out.error === 'bad_code' ? 'The sync code is wrong. Check it under Sync between devices.'
          : out.error === 'locked' ? 'Sync is locked for 10 minutes after too many wrong codes.'
          : 'Sync was refused (' + out.error + ').';
        return;
      }
      // Clear only what was sent; anything scanned while the request was in flight stays queued
      for (const [id, s] of snap) {
        const l = loads.find((x) => x.id === id);
        if (!l) continue;
        if (s.head && l.updatedAt === s.updatedAt) l._headDirty = false;
        s.keys.forEach((k) => dropKey(l._dirtyKeys, k));
        s.removed.forEach((k) => dropKey(l._removedKeys, k));
        if (l.deleted && !l._headDirty) await dropLocal(l.id);
        else await persist(l);
      }
      let changed = false;
      for (const r of out.loads || []) { if (await mergeRemote(r)) changed = true; }
      settings.since = out.server_time;
      saveSettings();
      sync.error = null;
      sync.lastOk = new Date().toISOString();
      if (changed) refreshAfterSync();
      again = loads.some((l) => pendingCount(l) > 0);
    } catch (e) {
      sync.error = e.name === 'AbortError' ? 'Sync timed out. It will retry.' : 'Could not reach the server. It will retry.';
      console.warn('sync', e);
    } finally {
      sync.busy = false;
      updateSyncUI();
      if (view === 'home') renderHomeList();
      scheduleSync(again ? 300 : SYNC_EVERY_MS);
    }
  }

  function refreshAfterSync() {
    if (view === 'scan') {
      if (current && !loads.includes(current)) {
        renderHome();
        alert('This load was deleted on another device.');
        return;
      }
      // Re-render stats/rows only; don't move focus or clear a pallet in progress
      const p = pending, s = step;
      const vals = [els.inPallet.value, els.inPgid.value, els.inQty.value];
      renderScan();
      pending = p; step = s;
      [els.inPallet.value, els.inPgid.value, els.inQty.value] = vals;
      setStepUI();
    }
  }

  function updateSyncUI() {
    const waiting = loads.reduce((a, l) => a + pendingCount(l), 0);
    let text, cls;
    if (!settings.code) { text = 'Sync off'; cls = 'pill-warn'; }
    else if (sync.error && /code|locked|refused/.test(sync.error)) { text = 'Sync code problem'; cls = 'pill-bad'; }
    else if (sync.busy) { text = 'Syncing'; cls = ''; }
    else if (waiting) { text = waiting + ' to sync'; cls = 'pill-warn'; }
    else if (sync.lastOk) { text = 'Synced'; cls = 'pill-ok'; }
    else { text = 'Not synced yet'; cls = 'pill-warn'; }
    els.syncPill.textContent = text;
    els.syncPill.className = 'pill ' + cls;
    const parts = [];
    if (!settings.code) parts.push('Enter the sync code to share loads between devices.');
    else {
      parts.push(sync.lastOk ? 'Last synced ' + fmtTime(sync.lastOk) + '.' : 'Not synced yet.');
      parts.push(waiting ? waiting + ' change(s) waiting to upload.' : 'Nothing waiting to upload.');
      if (!navigator.onLine) parts.push('No signal right now; scans are safe on this device.');
      if (sync.error) parts.push(sync.error);
    }
    els.syncStatus.textContent = parts.join(' ');
    els.syncStatus.className = 'meta' + (sync.error && settings.code ? ' sync-err' : '');
  }

  // ---------- camera ----------
  let cam = null, camTarget = null;
  async function openCamera(targetId) {
    if (typeof Html5Qrcode === 'undefined') return alert('Camera scanning is not available on this device.');
    camTarget = targetId;
    const label = { inPallet: 'Pallet ID', inPgid: 'PGID', inQty: 'QTY' }[targetId];
    els.camTitle.textContent = 'Scan ' + label;
    els.camHint.textContent = 'Hold the barcode flat and fill the box.';
    els.camOverlay.hidden = false;
    const F = Html5QrcodeSupportedFormats;
    cam = new Html5Qrcode('camReader', {
      formatsToSupport: [F.CODE_128, F.CODE_39, F.CODE_93, F.QR_CODE, F.DATA_MATRIX, F.EAN_13, F.UPC_A, F.ITF],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true }, verbose: false
    });
    try {
      await cam.start({ facingMode: 'environment' },
        { fps: 12, qrbox: (w, h) => ({ width: Math.floor(w * 0.9), height: Math.floor(Math.min(h, w) * 0.45) }) },
        onCamResult, () => {});
    } catch (e) {
      els.camHint.textContent = 'Could not start the camera. Allow camera access in the browser settings, or type the value.';
    }
  }
  async function closeCamera() {
    if (cam) { try { await cam.stop(); } catch (e) { /* not running */ } try { cam.clear(); } catch (e) { /* ignore */ } cam = null; }
    els.camOverlay.hidden = true;
  }
  async function onCamResult(text) {
    const t = camTarget;
    await closeCamera();
    $(t).value = text;
    ({ inPallet: handlePallet, inPgid: handlePgid, inQty: handleQty })[t]();
  }

  // ---------- events ----------
  els.back.addEventListener('click', () => { closeCamera(); renderHome(); });
  els.newLoad.addEventListener('click', () => openForm(null));
  els.form.addEventListener('submit', submitForm);
  els.formCancel.addEventListener('click', () => { editingId && current ? openScan(current) : renderHome(); });
  els.loadList.addEventListener('click', (e) => {
    const b = e.target.closest('.load-item'); if (!b) return;
    const l = loads.find((x) => x.id === b.dataset.id); if (l) openScan(l);
  });
  bindScanInput(els.inPallet, handlePallet, 'pallet');
  bindScanInput(els.inPgid, handlePgid, 'pgid');
  bindScanInput(els.inQty, handleQty, 'qty');
  els.clearRow.addEventListener('click', () => { resetPending(); setMsg('Cleared. Scan the Pallet ID.'); goStep('pallet'); });
  els.editHead.addEventListener('click', () => openForm(current));
  els.rows.addEventListener('click', async (e) => {
    const b = e.target.closest('.del-btn'); if (!b) return;
    const pid = b.dataset.pid;
    if (!confirm(`Remove pallet ${pid} from this load?`)) return;
    const k = norm(pid);
    current.pallets = current.pallets.filter((p) => norm(p.palletId) !== k);
    dropKey(current._dirtyKeys, k);
    addKey(current._removedKeys, k);
    await saveLoad(current);
    renderScan();
    setMsg(`Removed pallet ${pid}.`);
    goStep('pallet');
  });
  els.print.addEventListener('click', () => printLoad(current));
  els.csv.addEventListener('click', () => download(`OneSource_${safeName(current.loadNo)}_${stamp()}.csv`, toCsv([current]), 'text/csv'));
  els.closeLoad.addEventListener('click', async () => {
    if (current.status === 'open') {
      if (!confirm(`Close load ${current.loadNo} with ${current.pallets.length} pallets and ${totalQty(current)} total qty?`)) return;
      current.status = 'closed';
    } else {
      current.status = 'open';
    }
    current._headDirty = true;
    await saveLoad(current);
    resetPending();
    renderScan();
    if (current.status === 'open') { setMsg('Load reopened. Scan the Pallet ID.'); goStep('pallet'); }
  });
  els.deleteLoad.addEventListener('click', async () => {
    const typed = prompt(`This deletes load ${current.loadNo} and its ${current.pallets.length} pallets${settings.code ? ' from every synced device' : ' from this device'}.\n\nType the load number to confirm:`);
    if (typed == null) return;
    if (norm(typed) !== norm(current.loadNo)) return alert('Load number did not match. Nothing was deleted.');
    current.deleted = true;
    current._headDirty = true;
    await saveLoad(current);
    renderHome();
  });
  els.exportAll.addEventListener('click', () => {
    if (!live().length) return alert('There are no loads to export yet.');
    download(`OneSource_AllLoads_${stamp()}.csv`, toCsv(live()), 'text/csv');
  });
  els.backup.addEventListener('click', () => {
    download(`OneSource_Inbound_Backup_${stamp()}.json`, JSON.stringify({ app: 'lwh-os-inbound', version: APP_VERSION, exportedAt: new Date().toISOString(), loads: live() }, null, 1), 'application/json');
  });
  els.restore.addEventListener('change', async () => {
    const f = els.restore.files[0]; els.restore.value = '';
    if (f) await restoreFile(f);
  });
  els.saveSync.addEventListener('click', () => {
    const code = clean(els.syncCode.value);
    const dev = clean(els.deviceName.value) || settings.device;
    if (code !== settings.code) { settings.since = null; sync.error = null; }
    settings.code = code;
    settings.device = dev.slice(0, 60);
    saveSettings();
    updateSyncUI();
    syncNow();
  });
  els.syncNow.addEventListener('click', () => syncNow());
  document.querySelectorAll('.cam-btn').forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.target;
    if (t === 'inPgid' && !pending.palletId) return goStep('pallet');
    if (t === 'inQty' && !pending.pgid) return goStep(pending.palletId ? 'pgid' : 'pallet');
    openCamera(t);
  }));
  els.camClose.addEventListener('click', closeCamera);
  window.addEventListener('afterprint', () => { els.printArea.innerHTML = ''; });

  // ---------- network + offline readiness ----------
  function updateNet() {
    const on = navigator.onLine;
    els.netPill.textContent = on ? 'Online' : 'No internet';
    els.netPill.className = 'pill ' + (on ? 'pill-ok' : 'pill-warn');
    updateSyncUI();
  }
  window.addEventListener('online', () => { updateNet(); scheduleSync(500); });
  window.addEventListener('offline', updateNet);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(300); });

  async function checkOfflineReady() {
    try {
      const keys = await caches.keys();
      const ready = keys.some((k) => k === 'os-inbound-' + APP_VERSION) && navigator.serviceWorker && navigator.serviceWorker.controller;
      els.offlinePill.textContent = ready ? 'Offline ready' : 'Not offline-ready';
      els.offlinePill.className = 'pill ' + (ready ? 'pill-ok' : 'pill-warn');
    } catch (e) { /* caches unavailable */ }
  }

  if ('serviceWorker' in navigator) {
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then(() => setTimeout(checkOfflineReady, 1500)).catch(console.error);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) els.updateBar.hidden = false;
      hadController = true;
      checkOfflineReady();
    });
  }
  els.reloadBtn.addEventListener('click', () => location.reload());

  // ---------- start ----------
  (async function init() {
    els.ver.textContent = 'One Source Inbound v' + APP_VERSION;
    saveSettings();
    updateNet();
    if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) { /* ignore */ } }
    await loadAll();
    renderHome();
    checkOfflineReady();
    scheduleSync(400);
  })();
})();
