/* app.js */
"use strict";

/** ---------- Utilities ---------- */
const $ = (sel) => document.querySelector(sel);
const money = (n) => {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
};
const pct = (n) => `${(Number.isFinite(n) ? n : 0).toFixed(1)}%`;
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const ym = (dateStr) => {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  return dateStr.slice(0, 7);
};
const uid = () => crypto.randomUUID?.() ?? `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;

function toast(msg) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2200);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** ---------- Condition helpers (ONLY 4) ---------- */
const CONDITION_LABELS = {
  new_sealed: "New (sealed)",
  new_openbox: "New (open box)",
  used_complete: "Used (complete)",
  used_incomplete: "Used (incomplete)"
};

function normalizeCondition(v) {
  const key = (v || "").trim();
  return CONDITION_LABELS[key] ? key : "used_incomplete";
}

function conditionBadge(condKey) {
  const key = normalizeCondition(condKey);
  const label = CONDITION_LABELS[key];
  const emoji = ({
    new_sealed: "🟩",
    new_openbox: "🟨",
    used_complete: "🟦",
    used_incomplete: "🟧"
  })[key] || "🟧";

  return `<span class="badge cond">${emoji} ${escapeHtml(label)}</span>`;
}

/** ---------- Batch helpers ---------- */
function normalizeBatch(v) {
  return (v || "").trim();
}
function batchBadge(batch) {
  const b = normalizeBatch(batch);
  if (!b) return `<span class="small">—</span>`;
  return `<span class="badge batch">📦 ${escapeHtml(b)}</span>`;
}

/** ---------- IndexedDB ---------- */
const DB_NAME = "legoFlipDB";
const DB_VERSION = 1;
const STORE = "flips";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("purchaseDate", "purchaseDate");
      store.createIndex("soldDate", "soldDate");
      store.createIndex("name", "name");
      store.createIndex("batch", "batch");
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function txReadAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function txPut(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.put(item);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function txDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/** ---------- Domain logic ---------- */
function calc(item) {
  const purchaseCost = toNum(item.purchaseCost);
  const materialCost = toNum(item.materialCost);
  const fees = toNum(item.fees);
  const soldPrice = toNum(item.soldPrice);

  const totalCost = purchaseCost + materialCost + fees;
  const revenue = soldPrice;
  const profit = revenue - totalCost;
  const roi = totalCost > 0 ? (profit / totalCost) * 100 : 0;

  const sold = !!item.soldDate && revenue > 0;
  return { totalCost, revenue, profit, roi, sold };
}

function normalizeFormData(fd) {
  const obj = Object.fromEntries(fd.entries());
  return {
    id: obj.id || uid(),
    name: (obj.name || "").trim(),
    setNumber: (obj.setNumber || "").trim(),
    purchaseDate: obj.purchaseDate || "",
    soldDate: obj.soldDate || "",
    condition: normalizeCondition(obj.condition),
    batch: normalizeBatch(obj.batch),
    purchaseCost: toNum(obj.purchaseCost),
    materialCost: toNum(obj.materialCost),
    soldPrice: toNum(obj.soldPrice),
    fees: toNum(obj.fees),
    boughtFrom: (obj.boughtFrom || "").trim(),
    soldOn: (obj.soldOn || "").trim(),
    buyPayment: (obj.buyPayment || "").trim(),
    sellPayment: (obj.sellPayment || "").trim(),
    notes: (obj.notes || "").trim(),
    updatedAt: Date.now()
  };
}

/** ---------- Rendering ---------- */
let allFlips = [];
let profitLineChart = null;
let marketBarChart = null;
let conditionBarChart = null;
let batchBarChart = null;

function renderTable(list) {
  const tbody = $("#flipTbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const sorted = [...list].sort((a, b) => {
    const ad = a.purchaseDate || "0000-00-00";
    const bd = b.purchaseDate || "0000-00-00";
    if (ad !== bd) return bd.localeCompare(ad);
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  for (const item of sorted) {
    const { totalCost, revenue, profit, roi, sold } = calc(item);

    const tr = document.createElement("tr");
    const itemTitle = `${item.name || "(unnamed)"}${item.setNumber ? ` • #${item.setNumber}` : ""}`;
    const statusBadge = sold
      ? `<span class="badge sold">✅ Sold</span>`
      : `<span class="badge unsold">🕒 Unsold</span>`;

    const cond = conditionBadge(item.condition);
    const batch = batchBadge(item.batch);

    tr.innerHTML = `
      <td>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div style="font-weight:900;">${escapeHtml(itemTitle)}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            ${statusBadge}
            ${cond}
            ${item.boughtFrom ? `<span class="badge">🛒 ${escapeHtml(item.boughtFrom)}</span>` : ""}
            ${item.buyPayment ? `<span class="badge">💳 ${escapeHtml(item.buyPayment)}</span>` : ""}
            ${normalizeBatch(item.batch) ? batch : ""}
          </div>
          ${item.notes ? `<div class="small">${escapeHtml(item.notes)}</div>` : ""}
        </div>
      </td>

      <td class="mono">
        <div>${escapeHtml(item.purchaseDate || "—")}</div>
        <div class="small">Buy: ${money(toNum(item.purchaseCost))}</div>
      </td>

      <td class="mono">
        <div>${escapeHtml(item.soldDate || "—")}</div>
        <div class="small">Price: ${money(toNum(item.soldPrice))}</div>
      </td>

      <td class="mono">${money(totalCost)}</td>
      <td class="mono">${money(revenue)}</td>

      <td class="mono" style="font-weight:900;color:${profit >= 0 ? "rgba(34,197,94,0.95)" : "rgba(239,68,68,0.95)"};">
        ${money(profit)}
      </td>

      <td class="mono">${pct(roi)}</td>

      <td>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <div>${escapeHtml(item.soldOn || "—")}</div>
          <div class="small">${escapeHtml(item.sellPayment || "")}</div>
        </div>
      </td>

      <td>${cond}</td>
      <td>${batch}</td>

      <td>
        <div class="rowActions">
          <button class="iconBtn" data-edit="${item.id}" title="Edit">✏️</button>
          <button class="iconBtn" data-del="${item.id}" title="Delete">🗑️</button>
        </div>
      </td>
    `;

    tbody.appendChild(tr);
  }
}

function renderKPIs(list) {
  let totalProfit = 0;
  let totalRevenue = 0;
  let totalCosts = 0;

  for (const item of list) {
    const { totalCost, revenue, profit } = calc(item);
    totalProfit += profit;
    totalRevenue += revenue;
    totalCosts += totalCost;
  }

  const roi = totalCosts > 0 ? (totalProfit / totalCosts) * 100 : 0;

  $("#kpiProfit") && ($("#kpiProfit").textContent = money(totalProfit));
  $("#kpiRevenue") && ($("#kpiRevenue").textContent = money(totalRevenue));
  $("#kpiCosts") && ($("#kpiCosts").textContent = money(totalCosts));
  $("#kpiROI") && ($("#kpiROI").textContent = pct(roi));
}

function updateBatchUIFromAllFlips(flips) {
  // Update datalist for form autocomplete + batch filter dropdown
  const batches = [...new Set(flips.map(f => normalizeBatch(f.batch)).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const dl = $("#batchList");
  if (dl) {
    dl.innerHTML = batches.map(b => `<option value="${escapeHtml(b)}"></option>`).join("");
  }

  const bf = $("#batchFilter");
  if (bf) {
    const current = bf.value || "all";
    const options = [
      `<option value="all">All Batches</option>`,
      ...batches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`)
    ].join("");
    bf.innerHTML = options;
    // restore selection if still exists
    if ([...bf.options].some(o => o.value === current)) bf.value = current;
    else bf.value = "all";
  }
}

function renderCharts(list) {
  if (!window.Chart) return;

  // Profit over time
  const profitByMonth = new Map();
  for (const item of list) {
    const key = ym(item.soldDate);
    if (!key) continue;
    const { profit } = calc(item);
    profitByMonth.set(key, (profitByMonth.get(key) || 0) + profit);
  }
  const months = [...profitByMonth.keys()].sort();
  const profitVals = months.map(m => profitByMonth.get(m) || 0);

  // Profit by marketplace (sold only)
  const profitByMarket = new Map();
  for (const item of list) {
    const { profit, sold } = calc(item);
    if (!sold) continue;
    const market = (item.soldOn || "").trim() || "Unknown";
    profitByMarket.set(market, (profitByMarket.get(market) || 0) + profit);
  }
  const markets = [...profitByMarket.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const marketLabels = markets.map(([k]) => k);
  const marketVals = markets.map(([, v]) => v);

  // Profit by condition (sold only)
  const profitByCond = new Map();
  for (const item of list) {
    const { profit, sold } = calc(item);
    if (!sold) continue;
    const c = normalizeCondition(item.condition);
    profitByCond.set(c, (profitByCond.get(c) || 0) + profit);
  }
  const condOrder = ["new_sealed", "new_openbox", "used_complete", "used_incomplete"];
  const condLabels = condOrder.map(k => CONDITION_LABELS[k]);
  const condVals = condOrder.map(k => profitByCond.get(k) || 0);

  // Profit by batch (sold only)
  const profitByBatch = new Map();
  for (const item of list) {
    const { profit, sold } = calc(item);
    if (!sold) continue;
    const b = normalizeBatch(item.batch) || "No Batch";
    profitByBatch.set(b, (profitByBatch.get(b) || 0) + profit);
  }
  const batchesTop = [...profitByBatch.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const batchLabels = batchesTop.map(([k]) => k);
  const batchVals = batchesTop.map(([, v]) => v);

  const common = { color: "#e5edff", grid: "rgba(255,255,255,0.08)" };

  // Line
  const lineEl = $("#profitLine");
  if (lineEl) {
    const lineCtx = lineEl.getContext("2d");
    if (profitLineChart) profitLineChart.destroy();
    profitLineChart = new Chart(lineCtx, {
      type: "line",
      data: {
        labels: months.length ? months : ["—"],
        datasets: [{
          label: "Profit",
          data: months.length ? profitVals : [0],
          borderColor: "rgba(34,197,94,0.95)",
          backgroundColor: "rgba(34,197,94,0.20)",
          fill: true,
          tension: 0.25,
          pointRadius: 3
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: common.color } },
          tooltip: { callbacks: { label: (ctx) => ` ${money(ctx.parsed.y)}` } }
        },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } }
        }
      }
    });
  }

  // Market bar
  const marketEl = $("#marketBar");
  if (marketEl) {
    const barCtx = marketEl.getContext("2d");
    if (marketBarChart) marketBarChart.destroy();
    marketBarChart = new Chart(barCtx, {
      type: "bar",
      data: {
        labels: marketLabels.length ? marketLabels : ["—"],
        datasets: [{
          label: "Profit",
          data: marketLabels.length ? marketVals : [0],
          backgroundColor: (ctx) => (ctx.raw ?? 0) >= 0 ? "rgba(34,197,94,0.55)" : "rgba(239,68,68,0.55)",
          borderColor: "rgba(255,255,255,0.18)",
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: common.color } },
          tooltip: { callbacks: { label: (ctx) => ` ${money(ctx.parsed.y)}` } }
        },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } }
        }
      }
    });
  }

  // Condition bar
  const condEl = $("#conditionBar");
  if (condEl) {
    const condCtx = condEl.getContext("2d");
    if (conditionBarChart) conditionBarChart.destroy();
    conditionBarChart = new Chart(condCtx, {
      type: "bar",
      data: {
        labels: condLabels,
        datasets: [{
          label: "Profit",
          data: condVals,
          backgroundColor: (ctx) => (ctx.raw ?? 0) >= 0 ? "rgba(59,130,246,0.45)" : "rgba(239,68,68,0.55)",
          borderColor: "rgba(255,255,255,0.18)",
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: common.color } },
          tooltip: { callbacks: { label: (ctx) => ` ${money(ctx.parsed.y)}` } }
        },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } }
        }
      }
    });
  }

  // Batch bar
  const batchEl = $("#batchBar");
  if (batchEl) {
    const batchCtx = batchEl.getContext("2d");
    if (batchBarChart) batchBarChart.destroy();
    batchBarChart = new Chart(batchCtx, {
      type: "bar",
      data: {
        labels: batchLabels.length ? batchLabels : ["—"],
        datasets: [{
          label: "Profit",
          data: batchLabels.length ? batchVals : [0],
          backgroundColor: (ctx) => (ctx.raw ?? 0) >= 0 ? "rgba(168,85,247,0.45)" : "rgba(239,68,68,0.55)",
          borderColor: "rgba(255,255,255,0.18)",
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: common.color } },
          tooltip: { callbacks: { label: (ctx) => ` ${money(ctx.parsed.y)}` } }
        },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } }
        }
      }
    });
  }
}

/** ---------- Filters ---------- */
function getFiltered() {
  const q = ($("#searchInput")?.value || "").trim().toLowerCase();
  const status = $("#statusFilter")?.value || "all";
  const condFilter = $("#conditionFilter")?.value || "all";
  const batchFilter = $("#batchFilter")?.value || "all";

  return allFlips.filter(item => {
    const { sold } = calc(item);

    if (status === "sold" && !sold) return false;
    if (status === "unsold" && sold) return false;

    const itemCond = normalizeCondition(item.condition);
    if (condFilter !== "all" && itemCond !== condFilter) return false;

    const b = normalizeBatch(item.batch);
    if (batchFilter !== "all" && b !== batchFilter) return false;

    if (!q) return true;
    const hay = [
      item.name, item.setNumber, item.boughtFrom, item.soldOn,
      item.buyPayment, item.sellPayment, item.notes,
      CONDITION_LABELS[itemCond] || "",
      item.batch || ""
    ].join(" ").toLowerCase();

    return hay.includes(q);
  });
}

function rerender() {
  const list = getFiltered();
  renderTable(list);
  renderKPIs(list);
  renderCharts(list);
}

/** ---------- Form actions ---------- */
function setForm(item) {
  const f = $("#flipForm");
  if (!f) return;

  f.id.value = item?.id || "";
  f.name.value = item?.name || "";
  f.setNumber.value = item?.setNumber || "";
  f.purchaseDate.value = item?.purchaseDate || "";
  f.soldDate.value = item?.soldDate || "";
  f.condition.value = normalizeCondition(item?.condition || "new_sealed");
  f.batch.value = item?.batch || "";
  f.purchaseCost.value = item?.purchaseCost ?? "";
  f.materialCost.value = item?.materialCost ?? 0;
  f.soldPrice.value = item?.soldPrice ?? 0;
  f.fees.value = item?.fees ?? 0;
  f.boughtFrom.value = item?.boughtFrom || "";
  f.soldOn.value = item?.soldOn || "";
  f.buyPayment.value = item?.buyPayment || "";
  f.sellPayment.value = item?.sellPayment || "";
  f.notes.value = item?.notes || "";
}

function resetForm() {
  setForm(null);
  $("#saveBtn") && ($("#saveBtn").textContent = "Save Flip");
}

async function saveForm(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const item = normalizeFormData(fd);

  if (!item.name) return toast("Name is required.");
  if (!item.purchaseDate) return toast("Purchase date is required.");

  await txPut(item);
  toast("Saved ✅");

  allFlips = await txReadAll();
  updateBatchUIFromAllFlips(allFlips);
  resetForm();
  rerender();
}

async function handleTableClick(ev) {
  const editId = ev.target?.getAttribute?.("data-edit");
  const delId = ev.target?.getAttribute?.("data-del");

  if (editId) {
    const item = allFlips.find(x => x.id === editId);
    if (!item) return;
    setForm(item);
    $("#saveBtn") && ($("#saveBtn").textContent = "Update Flip");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (delId) {
    const item = allFlips.find(x => x.id === delId);
    if (!item) return;
    const ok = confirm(`Delete "${item.name}"? This cannot be undone.`);
    if (!ok) return;
    await txDelete(delId);
    toast("Deleted 🗑️");
    allFlips = await txReadAll();
    updateBatchUIFromAllFlips(allFlips);
    rerender();
  }
}

/** ---------- Export / Import ---------- */
async function exportData() {
  const data = await txReadAll();
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), flips: data }, null, 2)], {
    type: "application/json"
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `lego-flips-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Exported 📦");
}

async function importData(file) {
  const text = await file.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { toast("Invalid JSON file."); return; }

  const flips = Array.isArray(parsed) ? parsed : parsed.flips;
  if (!Array.isArray(flips)) { toast("No flips found in file."); return; }

  for (const raw of flips) {
    const item = {
      id: raw.id || uid(),
      name: (raw.name || "").trim(),
      setNumber: (raw.setNumber || "").trim(),
      purchaseDate: raw.purchaseDate || "",
      soldDate: raw.soldDate || "",
      condition: normalizeCondition(raw.condition),
      batch: normalizeBatch(raw.batch),
      purchaseCost: toNum(raw.purchaseCost),
      materialCost: toNum(raw.materialCost),
      soldPrice: toNum(raw.soldPrice),
      fees: toNum(raw.fees),
      boughtFrom: (raw.boughtFrom || "").trim(),
      soldOn: (raw.soldOn || "").trim(),
      buyPayment: (raw.buyPayment || "").trim(),
      sellPayment: (raw.sellPayment || "").trim(),
      notes: (raw.notes || "").trim(),
      updatedAt: Date.now()
    };
    if (!item.name || !item.purchaseDate) continue;
    await txPut(item);
  }

  allFlips = await txReadAll();
  updateBatchUIFromAllFlips(allFlips);
  rerender();
  toast("Imported ✅");
}

/** ---------- Install (PWA) ---------- */
let deferredPrompt = null;

function setupInstallFlow() {
  const installBtn = $("#installBtn");
  const hint = $("#installHint");

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.hidden = false;
    if (hint) hint.textContent = "Install to your phone for offline use";
  });

  installBtn?.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const res = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (installBtn) installBtn.hidden = true;
    toast(res?.outcome === "accepted" ? "Installed 🎉" : "Install canceled");
  });
}

/** ---------- Service worker ---------- */
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try { await navigator.serviceWorker.register("./sw.js"); }
  catch (e) { console.warn("SW registration failed:", e); }
}

/** ---------- Init ---------- */
async function init() {
  const form = $("#flipForm");
  if (!form) return;

  // default purchase date
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  form.purchaseDate.value = `${yyyy}-${mm}-${dd}`;

  form.addEventListener("submit", saveForm);
  $("#resetBtn")?.addEventListener("click", resetForm);
  $("#flipTbody")?.addEventListener("click", handleTableClick);

  $("#searchInput")?.addEventListener("input", rerender);
  $("#statusFilter")?.addEventListener("change", rerender);
  $("#conditionFilter")?.addEventListener("change", rerender);
  $("#batchFilter")?.addEventListener("change", rerender);

  $("#exportBtn")?.addEventListener("click", exportData);
  $("#importInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await importData(file);
    e.target.value = "";
  });

  setupInstallFlow();
  await registerSW();

  allFlips = await txReadAll();

  // Normalize condition to allowed 4 + ensure batch exists
  let changed = false;
  for (const item of allFlips) {
    const c = normalizeCondition(item.condition);
    if (item.condition !== c) { item.condition = c; changed = true; }
    if (typeof item.batch !== "string") { item.batch = ""; changed = true; }
    if (changed) { item.updatedAt = Date.now(); await txPut(item); }
    changed = false;
  }
  allFlips = await txReadAll();

  updateBatchUIFromAllFlips(allFlips);
  rerender();

  // charts might load slightly after Chart.js
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (window.Chart) {
      clearInterval(t);
      renderCharts(getFiltered());
    }
    if (tries > 40) clearInterval(t);
  }, 100);
}

init();

  
