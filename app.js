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
  // "YYYY-MM-DD" -> "YYYY-MM"
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  return dateStr.slice(0, 7);
};
const uid = () => crypto.randomUUID?.() ?? `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2200);
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

function renderTable(list) {
  const tbody = $("#flipTbody");
  tbody.innerHTML = "";

  // newest first by purchase date then updated
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

    tr.innerHTML = `
      <td>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div style="font-weight:900;">${escapeHtml(itemTitle)}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            ${statusBadge}
            ${item.boughtFrom ? `<span class="badge">🛒 ${escapeHtml(item.boughtFrom)}</span>` : ""}
            ${item.buyPayment ? `<span class="badge">💳 ${escapeHtml(item.buyPayment)}</span>` : ""}
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

  $("#kpiProfit").textContent = money(totalProfit);
  $("#kpiRevenue").textContent = money(totalRevenue);
  $("#kpiCosts").textContent = money(totalCosts);
  $("#kpiROI").textContent = pct(roi);
}

function renderCharts(list) {
  // Profit over time (by sold month)
  const profitByMonth = new Map();
  for (const item of list) {
    const key = ym(item.soldDate);
    if (!key) continue;
    const { profit } = calc(item);
    profitByMonth.set(key, (profitByMonth.get(key) || 0) + profit);
  }

  const months = [...profitByMonth.keys()].sort();
  const profitVals = months.map(m => profitByMonth.get(m) || 0);

  // Profit by marketplace (soldOn)
  const profitByMarket = new Map();
  for (const item of list) {
    const market = (item.soldOn || "").trim() || "Unknown";
    const { profit, sold } = calc(item);
    if (!sold) continue;
    profitByMarket.set(market, (profitByMarket.get(market) || 0) + profit);
  }

  const markets = [...profitByMarket.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const marketLabels = markets.map(([k]) => k);
  const marketVals = markets.map(([, v]) => v);

  // Wait until Chart is available
  if (!window.Chart) return;

  const common = {
    color: "#e5edff",
    grid: "rgba(255,255,255,0.08)"
  };

  // Line chart
  const lineCtx = $("#profitLine").getContext("2d");
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
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${money(ctx.parsed.y)}`
          }
        }
      },
      scales: {
        x: { ticks: { color: common.color }, grid: { color: common.grid } },
        y: {
          ticks: { color: common.color, callback: (v) => money(v) },
          grid: { color: common.grid }
        }
      }
    }
  });

  // Bar chart
  const barCtx = $("#marketBar").getContext("2d");
  if (marketBarChart) marketBarChart.destroy();
  marketBarChart = new Chart(barCtx, {
    type: "bar",
    data: {
      labels: marketLabels.length ? marketLabels : ["—"],
      datasets: [{
        label: "Profit",
        data: marketLabels.length ? marketVals : [0],
        backgroundColor: (ctx) => {
          const v = ctx.raw ?? 0;
          return v >= 0 ? "rgba(34,197,94,0.55)" : "rgba(239,68,68,0.55)";
        },
        borderColor: "rgba(255,255,255,0.18)",
        borderWidth: 1
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: common.color } } },
      scales: {
        x: { ticks: { color: common.color }, grid: { color: common.grid } },
        y: {
          ticks: { color: common.color, callback: (v) => money(v) },
          grid: { color: common.grid }
        }
      }
    }
  });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** ---------- Filters ---------- */
function getFiltered() {
  const q = ($("#searchInput").value || "").trim().toLowerCase();
  const status = $("#statusFilter").value;

  return allFlips.filter(item => {
    const { sold } = calc(item);

    if (status === "sold" && !sold) return false;
    if (status === "unsold" && sold) return false;

    if (!q) return true;
    const hay = [
      item.name, item.setNumber, item.boughtFrom, item.soldOn,
      item.buyPayment, item.sellPayment, item.notes
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
  f.id.value = item?.id || "";
  f.name.value = item?.name || "";
  f.setNumber.value = item?.setNumber || "";
  f.purchaseDate.value = item?.purchaseDate || "";
  f.soldDate.value = item?.soldDate || "";
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
  $("#saveBtn").textContent = "Save Flip";
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
    $("#saveBtn").textContent = "Update Flip";
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
  try {
    parsed = JSON.parse(text);
  } catch {
    toast("Invalid JSON file.");
    return;
  }

  const flips = Array.isArray(parsed) ? parsed : parsed.flips;
  if (!Array.isArray(flips)) {
    toast("No flips found in file.");
    return;
  }

  // Merge by id; if no id exists, assign one
  for (const raw of flips) {
    const item = {
      id: raw.id || uid(),
      name: (raw.name || "").trim(),
      setNumber: (raw.setNumber || "").trim(),
      purchaseDate: raw.purchaseDate || "",
      soldDate: raw.soldDate || "",
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
    if (!item.name || !item.purchaseDate) continue; // skip broken rows
    await txPut(item);
  }

  allFlips = await txReadAll();
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
    installBtn.hidden = false;
    hint.textContent = "Install to your phone for offline use";
  });

  installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const res = await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.hidden = true;
    toast(res?.outcome === "accepted" ? "Installed 🎉" : "Install canceled");
  });
}

/** ---------- Service worker ---------- */
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (e) {
    console.warn("SW registration failed:", e);
  }
}

/** ---------- Init ---------- */
async function init() {
  // default dates
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  $("#flipForm").purchaseDate.value = `${yyyy}-${mm}-${dd}`;

  $("#flipForm").addEventListener("submit", saveForm);
  $("#resetBtn").addEventListener("click", resetForm);

  $("#flipTbody").addEventListener("click", handleTableClick);

  $("#searchInput").addEventListener("input", rerender);
  $("#statusFilter").addEventListener("change", rerender);

  $("#exportBtn").addEventListener("click", exportData);

  $("#importInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await importData(file);
    e.target.value = "";
  });

  setupInstallFlow();
  await registerSW();

  allFlips = await txReadAll();
  rerender();

  // Charts might load slightly after; re-render once Chart.js is ready
  let tries = 0;
  const waitChart = setInterval(() => {
    tries++;
    if (window.Chart) {
      clearInterval(waitChart);
      renderCharts(getFiltered());
    }
    if (tries > 40) clearInterval(waitChart);
  }, 100);
}

init();