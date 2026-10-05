/* LWH One Source Inbound Scan
 * Offline-first: all data lives on this device (IndexedDB, mirrored to localStorage).
 */
(function () {
  'use strict';

  const APP_VERSION = '1.0.0';
  const DB_NAME = 'lwh-os-inbound';
  const STORE = 'loads';
  const LS_KEY = 'lwh-os-inbound-mirror';
  const QTY_MAX = 9999;

  // ---------- state ----------
  let loads = [];          // all loads in memory
  let current = null;      // load being scanned
  let editingId = null;    // load id being edited in the form (null = new)
  let step = 'pallet';     // pallet | pgid | qty
  let pending = { palletId: '', pgid: '' };
  let lastAddedTs = null;

  const $ = (id) => document.getElementById(id);
  const els = {
    back: $('backBtn'), netPill: $('netPill'), offlinePill: $('offlinePill'),
    updateBar: $('updateBar'), reloadBtn: $('reloadBtn'),
    vHome: $('viewHome'), vForm: $('viewForm'), vScan: $('viewScan'),
    newLoad: $('newLoadBtn'), loadList: $('loadList'),
    exportAll: $('exportAllBtn'), backup: $('backupBtn'), restore: $('restoreFile'), storageInfo: $('storageInfo'),
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
  async function saveLoad(load) {
    load.updatedAt = new Date().toISOString();
    mirror();
    try { await idbPut(load); }
    catch (e) { setMsg('Could not save to device storage. Export a backup now.', 'err'); console.error(e); }
  }
  async function loadAll() {
    let fromIdb = [];
    try { fromIdb = await idbAll(); } catch (e) { console.warn(e); }
    let fromLs = [];
    try { fromLs = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (e) { /* ignore */ }
    // Merge: prefer whichever copy was updated most recently
    const map = new Map();
    [...fromLs, ...fromIdb].forEach((l) => {
      const ex = map.get(l.id);
      if (!ex || (l.updatedAt || '') >= (ex.updatedAt || '')) map.set(l.id, l);
    });
    loads = [...map.values()];
    for (const l of loads) { try { await idbPut(l); } catch (e) { /* ignore */ } }
    mirror();
  }

  // ---------- helpers ----------
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  // Strip whitespace and control characters some scanners add (GS, CR, LF, etc.)
  const clean = (v) => String(v || '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const totalQty = (l) => l.pallets.reduce((a, p) => a + (Number(p.qty) || 0), 0);
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDate = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtDT = (iso) => fmtDate(iso) + ' ' + fmtTime(iso);
  const norm = (s) => clean(s).toUpperCase();

  function findPalletElsewhere(palletId) {
    const key = norm(palletId);
    for (const l of loads) {
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
  function show(view) {
    els.vHome.hidden = view !== 'home';
    els.vForm.hidden = view !== 'form';
    els.vScan.hidden = view !== 'scan';
    els.back.hidden = view === 'home';
    window.scrollTo(0, 0);
  }

  function renderHome() {
    current = null;
    const sorted = [...loads].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
    if (!sorted.length) {
      els.loadList.innerHTML = '<p class="empty">No loads yet. Tap Start new load when a One Source trailer is ready to unload.</p>';
    } else {
      els.loadList.innerHTML = sorted.map((l) => `
        <button class="load-item ${l.status === 'closed' ? 'closed' : ''}" data-id="${esc(l.id)}">
          <div>
            <div class="li-title">${esc(l.loadNo)}<span class="status ${l.status === 'closed' ? 'closed' : ''}">${l.status === 'closed' ? 'Closed' : 'Open'}</span></div>
            <div class="li-sub">${esc(l.carrier)} | Item ${esc(l.itemNo)} | Bin ${esc(l.binClass)} | ${esc(fmtDT(l.createdAt))}</div>
          </div>
          <div class="li-count"><strong>${l.pallets.length}</strong>pallets, ${totalQty(l)} qty</div>
        </button>`).join('');
    }
    const pallets = loads.reduce((a, l) => a + l.pallets.length, 0);
    els.storageInfo.textContent = `${loads.length} load(s), ${pallets} pallet(s) saved on this device.`;
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
    const p = { palletId: pending.palletId, pgid: pending.pgid, qty: Number(v), scannedAt: new Date().toISOString() };
    current.pallets.push(p);
    lastAddedTs = p.scannedAt;
    await saveLoad(current);
    beep(true); flash(true);
    resetPending();
    renderScan();
    setMsg(`Saved pallet ${current.pallets.length}: ${p.palletId}, qty ${p.qty}. Scan the next Pallet ID.`, 'ok');
    goStep('pallet');
  }

  function bindScanInput(input, handler, s) {
    input.addEventListener('keydown', (e) => {
      // Scanners usually send Enter; some are set to Tab. Treat both as "field done".
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.key === 'Tab' && e.shiftKey) return;
        e.preventDefault();
        handler();
      }
    });
    input.addEventListener('focus', () => {
      // Don't let someone skip ahead and lose track of the pallet in progress
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
    const dupe = loads.find((l) => l.id !== editingId && norm(l.loadNo) === norm(vals.loadNo));
    if (dupe && !confirm(`Load ${dupe.loadNo} already exists on this device. Create another load with the same number anyway?`)) {
      return openScan(dupe);
    }
    if (editingId) {
      const l = loads.find((x) => x.id === editingId);
      Object.assign(l, vals);
      await saveLoad(l);
      openScan(l);
    } else {
      const l = { id: uid(), ...vals, status: 'open', createdAt: new Date().toISOString(), updatedAt: '', pallets: [], appVersion: APP_VERSION };
      loads.push(l);
      await saveLoad(l);
      openScan(l);
    }
  }
  // Enter in a header field moves to the next one (scanner friendly)
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
    const head = ['Load_BOL', 'Carrier', 'Item_Number', 'Bin_Class', 'Pallet_ID', 'PGID', 'QTY', 'Scanned_At', 'Load_Created', 'Load_Status'];
    const out = [head.join(',')];
    list.forEach((l) => l.pallets.forEach((p) => {
      out.push([l.loadNo, l.carrier, l.itemNo, l.binClass, p.palletId, p.pgid, p.qty, p.scannedAt, l.createdAt, l.status].map(csvCell).join(','));
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
      if (!inc || !inc.id || !Array.isArray(inc.pallets)) continue;
      const ex = loads.find((l) => l.id === inc.id);
      if (!ex) { loads.push(inc); await saveLoad(inc); added++; palletsAdded += inc.pallets.length; continue; }
      const have = new Set(ex.pallets.map((p) => norm(p.palletId)));
      const extra = inc.pallets.filter((p) => !have.has(norm(p.palletId)));
      if (extra.length) {
        ex.pallets.push(...extra);
        ex.pallets.sort((a, b) => a.scannedAt.localeCompare(b.scannedAt));
        palletsAdded += extra.length; merged++;
        await saveLoad(ex);
      }
    }
    alert(`Restore complete: ${added} new load(s), ${merged} load(s) merged, ${palletsAdded} pallet(s) added.`);
    renderHome();
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
    const input = $(t);
    input.value = text;
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
    current.pallets = current.pallets.filter((p) => p.palletId !== pid);
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
    await saveLoad(current);
    resetPending();
    renderScan();
    if (current.status === 'open') { setMsg('Load reopened. Scan the Pallet ID.'); goStep('pallet'); }
  });
  els.deleteLoad.addEventListener('click', async () => {
    const typed = prompt(`This permanently deletes load ${current.loadNo} and its ${current.pallets.length} pallets from this device.\n\nType the load number to confirm:`);
    if (typed == null) return;
    if (norm(typed) !== norm(current.loadNo)) return alert('Load number did not match. Nothing was deleted.');
    loads = loads.filter((l) => l.id !== current.id);
    mirror();
    try { await idbDelete(current.id); } catch (e) { console.error(e); }
    renderHome();
  });
  els.exportAll.addEventListener('click', () => {
    if (!loads.length) return alert('There are no loads to export yet.');
    download(`OneSource_AllLoads_${stamp()}.csv`, toCsv(loads), 'text/csv');
  });
  els.backup.addEventListener('click', () => {
    download(`OneSource_Inbound_Backup_${stamp()}.json`, JSON.stringify({ app: 'lwh-os-inbound', version: APP_VERSION, exportedAt: new Date().toISOString(), loads }, null, 1), 'application/json');
  });
  els.restore.addEventListener('change', async () => {
    const f = els.restore.files[0]; els.restore.value = '';
    if (f) await restoreFile(f);
  });
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
  }
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);

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
    updateNet();
    if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) { /* ignore */ } }
    await loadAll();
    renderHome();
    checkOfflineReady();
  })();
})();
