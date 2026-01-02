/* app.js */
"use strict";

/** ---------- Utilities ---------- */
const $ = (sel) => document.querySelector(sel);
const money = (n) => {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
};
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

/** ---------- View Tabs ---------- */
function setView(viewId) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.querySelectorAll(".tabBtn").forEach(b => b.classList.remove("active"));

  const view = document.getElementById(viewId);
  if (view) view.classList.add("active");

  const btn = document.querySelector(`.tabBtn[data-view="${viewId}"]`);
  if (btn) btn.classList.add("active");

  window.scrollTo({ top: 0, behavior: "smooth" });

  // Chart canvases sometimes need a rerender once visible
  if (viewId === "viewStats") {
    try { rerender(); } catch {}
  }
}

/** ---------- Rebrickable ---------- */
const RB_KEY_STORAGE = "rebrickable_api_key";
function getRBKey() { return (localStorage.getItem(RB_KEY_STORAGE) || "").trim(); }
function setRBKey(key) {
  const k = (key || "").trim();
  if (!k) localStorage.removeItem(RB_KEY_STORAGE);
  else localStorage.setItem(RB_KEY_STORAGE, k);
}
async function ensureRBKey() {
  let key = getRBKey();
  if (key) return key;
  const entered = prompt("Enter your Rebrickable API key (free):");
  if (!entered) return "";
  setRBKey(entered);
  return getRBKey();
}
function normalizeSetNumberForRB(raw) {
  const s = (raw || "").trim();
  if (!s) return "";
  if (/^\d+$/.test(s)) return `${s}-1`;
  return s;
}
async function rebrickableLookup(setNumberRaw) {
  const key = await ensureRBKey();
  if (!key) { toast("No API key set."); return null; }

  const setNum = normalizeSetNumberForRB(setNumberRaw);
  if (!setNum) { toast("Type a set number first."); return null; }

  const url = `https://rebrickable.com/api/v3/lego/sets/${encodeURIComponent(setNum)}/?key=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) toast("API key rejected. Click API Key and try again.");
      else toast(`Lookup failed (${res.status}).`);
      return null;
    }
    const data = await res.json();
    return { name: data?.name || "", img: data?.set_img_url || "" };
  } catch (e) {
    console.warn(e);
    toast("Lookup error (network/CORS).");
    return null;
  }
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
function normalizeBatch(v) { return (v || "").trim(); }
function batchBadge(batch) {
  const b = normalizeBatch(batch);
  if (!b) return `<span class="small">—</span>`;
  return `<span class="badge batch">📦 ${escapeHtml(b)}</span>`;
}

/** ---------- Expenses: Category -> Cost Bucket ---------- */
const EXPENSE_CATEGORY_MAP = {
  Supplies: "material",
  Parts: "material",
  Shipping: "shipping",
  Gas: "other",
  "Fees (other)": "other",
  Other: "other"
};

/** ---------- IndexedDB ---------- */
const DB_NAME = "legoFlipDB";
const DB_VERSION = 3; // inventory + sales + expenses
const INVENTORY_STORE = "inventory";
const SALES_STORE = "sales";
const EXPENSES_STORE = "expenses";
const OLD_FLIPS_STORE = "flips"; // legacy

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(INVENTORY_STORE)) {
        const s = db.createObjectStore(INVENTORY_STORE, { keyPath: "id" });
        s.createIndex("purchaseDate", "purchaseDate");
        s.createIndex("batch", "batch");
        s.createIndex("setNumber", "setNumber");
        s.createIndex("name", "name");
        s.createIndex("status", "status");
      }

      if (!db.objectStoreNames.contains(SALES_STORE)) {
        const s = db.createObjectStore(SALES_STORE, { keyPath: "id" });
        s.createIndex("soldDate", "soldDate");
        s.createIndex("inventoryId", "inventoryId");
        s.createIndex("soldOn", "soldOn");
      }

      if (!db.objectStoreNames.contains(EXPENSES_STORE)) {
        const es = db.createObjectStore(EXPENSES_STORE, { keyPath: "id" });
        es.createIndex("date", "date");
        es.createIndex("category", "category");
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function txGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function txPut(storeName, item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const req = store.put(item);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function txDelete(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const req = store.delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function txClear(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const req = store.clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function storeExists(storeName) {
  const db = await openDB();
  const exists = db.objectStoreNames.contains(storeName);
  db.close();
  return exists;
}

/** ---------- In-memory state ---------- */
let inventory = [];
let sales = [];
let expenses = [];

let profitLineChart = null;
let marketBarChart = null;
let conditionBarChart = null;
let batchBarChart = null;

/** ---------- Domain: inventory + sales ---------- */
function isSoldItem(invItem) {
  return invItem?.status === "sold";
}
function getSaleByInventoryId(invId) {
  return sales.find(s => s.inventoryId === invId) || null;
}
function calcSaleNet(invItem, saleRec, allocator) {
  if (!invItem || !saleRec) return null;

  const revenue = toNum(saleRec.soldPrice);
  const purchase = toNum(invItem.purchaseCost);
  const material = toNum(invItem.materialCost);
  const shipping = toNum(saleRec.fees);

  const alloc = allocator.allocatedExpenseForSale(saleRec);
  const profitNet = revenue - purchase - material - shipping - alloc.total;

  return { revenue, purchase, material, shipping, alloc, profitNet };
}

/** ---------- Expense allocation (by sold month revenue share) ---------- */
function expenseBucketsByMonth(expensesList) {
  const byMonth = new Map();
  for (const e of expensesList) {
    const key = ym(e.date);
    if (!key) continue;
    const amt = toNum(e.amount);
    if (amt <= 0) continue;

    const bucket = EXPENSE_CATEGORY_MAP[(e.category || "").trim()] || "other";
    if (!byMonth.has(key)) byMonth.set(key, { material: 0, shipping: 0, other: 0, total: 0 });

    const obj = byMonth.get(key);
    obj[bucket] += amt;
    obj.total += amt;
  }
  return byMonth;
}

function buildExpenseAllocator(salesList, expensesList) {
  const expByMonth = expenseBucketsByMonth(expensesList);

  const revByMonth = new Map();
  const countByMonth = new Map();
  for (const s of salesList) {
    const key = ym(s.soldDate);
    if (!key) continue;
    const rev = toNum(s.soldPrice);
    revByMonth.set(key, (revByMonth.get(key) || 0) + rev);
    countByMonth.set(key, (countByMonth.get(key) || 0) + 1);
  }

  function allocatedExpenseForSale(saleRec) {
    const key = ym(saleRec?.soldDate);
    if (!key) return { material: 0, shipping: 0, other: 0, total: 0 };

    const monthExp = expByMonth.get(key);
    if (!monthExp) return { material: 0, shipping: 0, other: 0, total: 0 };

    const totalRev = revByMonth.get(key) || 0;
    const count = countByMonth.get(key) || 0;
    const rev = toNum(saleRec?.soldPrice);

    const share = totalRev > 0 ? (rev / totalRev) : (count > 0 ? 1 / count : 0);

    return {
      material: monthExp.material * share,
      shipping: monthExp.shipping * share,
      other: monthExp.other * share,
      total: monthExp.total * share
    };
  }

  return { expByMonth, allocatedExpenseForSale };
}

/** ---------- Rendering helpers ---------- */
function renderThumb(url, imgSel) {
  const img = $(imgSel);
  if (!img) return;
  const u = (url || "").trim();
  if (!u) {
    img.removeAttribute("src");
    img.style.display = "none";
    return;
  }
  img.src = u;
  img.style.display = "block";
}

function renderItemThumbHTML(url) {
  const u = (url || "").trim();
  if (!u) return "";
  const safe = escapeHtml(u);
  return `<a href="${safe}" target="_blank" rel="noopener"><img class="thumb clickable" src="${safe}" alt="set" loading="lazy" /></a>`;
}

/** ---------- Inventory list + filters ---------- */
function updateBatchFilter() {
  const batches = [...new Set(inventory.map(i => normalizeBatch(i.batch)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const bf = $("#batchFilter");
  if (!bf) return;

  const current = bf.value || "all";
  bf.innerHTML = [
    `<option value="all">All Batches</option>`,
    ...batches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`)
  ].join("");

  if ([...bf.options].some(o => o.value === current)) bf.value = current;
  else bf.value = "all";
}

function updateInventoryDatalist() {
  const dl = $("#inventoryList");
  if (!dl) return;

  const inStock = inventory.filter(i => i.status !== "sold");
  dl.innerHTML = inStock.map(i => {
    const label = `${(i.setNumber || "").trim()} ${i.name || ""}`.trim();
    return `<option value="${escapeHtml(label)}"></option>`;
  }).join("");
}

function resolveInventoryPickToId(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return "";

  for (const i of inventory) {
    if (i.status === "sold") continue;
    const label = `${(i.setNumber || "").trim()} ${i.name || ""}`.trim().toLowerCase();
    if (label === t) return i.id;
  }

  const maybeNum = (text || "").trim();
  const bySet = inventory.find(i => i.status !== "sold" && (i.setNumber || "").trim() === maybeNum);
  if (bySet) return bySet.id;

  const byName = inventory.find(i => i.status !== "sold" && (i.name || "").toLowerCase().includes(t));
  return byName?.id || "";
}

function getFilteredInventoryView() {
  const q = ($("#searchInput")?.value || "").trim().toLowerCase();
  const status = $("#statusFilter")?.value || "all";
  const condFilter = $("#conditionFilter")?.value || "all";
  const batchFilter = $("#batchFilter")?.value || "all";

  return inventory.filter(i => {
    const sold = isSoldItem(i);

    if (status === "sold" && !sold) return false;
    if (status === "in_stock" && sold) return false;

    const itemCond = normalizeCondition(i.condition);
    if (condFilter !== "all" && itemCond !== condFilter) return false;

    const b = normalizeBatch(i.batch);
    if (batchFilter !== "all" && b !== batchFilter) return false;

    if (!q) return true;

    const sale = getSaleByInventoryId(i.id);
    const hay = [
      i.name, i.setNumber, i.boughtFrom, i.buyPayment,
      i.batch, CONDITION_LABELS[itemCond] || "",
      sale?.soldOn || "", sale?.sellPayment || "", sale?.notes || ""
    ].join(" ").toLowerCase();

    return hay.includes(q);
  });
}

/** ---------- Expenses rendering ---------- */
function renderExpenseSummary() {
  const el = $("#expenseSummary");
  if (!el) return;

  const sums = {};
  for (const e of expenses) {
    const cat = (e.category || "Other").trim() || "Other";
    sums[cat] = (sums[cat] || 0) + toNum(e.amount);
  }
  const entries = Object.entries(sums).sort((a, b) => b[1] - a[1]);

  if (!entries.length) {
    el.innerHTML = `<div class="small">No expenses yet.</div>`;
    return;
  }

  el.innerHTML = entries
    .map(([cat, amt]) => `<div style="display:flex;justify-content:space-between;gap:12px;"><div><strong>${escapeHtml(cat)}</strong></div><div class="mono">${money(amt)}</div></div>`)
    .join("");
}

function renderExpensesTable() {
  const tb = $("#expenseTbody");
  if (!tb) return;
  tb.innerHTML = "";

  const sorted = [...expenses].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  for (const e of sorted) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${escapeHtml(e.date || "—")}</td>
      <td>${escapeHtml(e.category || "")}</td>
      <td>${escapeHtml(e.note || "")}</td>
      <td class="mono">${money(toNum(e.amount))}</td>
      <td><div class="rowActions"><button class="iconBtn" data-exp-del="${e.id}" title="Delete">🗑️</button></div></td>
    `;
    tb.appendChild(tr);
  }
}

/** ---------- KPIs ---------- */
function renderKPIs(allocator) {
  let revenue = 0;
  let purchaseCost = 0;
  let materialCost = 0;
  let shippingCost = 0;
  let otherCost = 0;

  for (const s of sales) {
    const inv = inventory.find(i => i.id === s.inventoryId);
    if (!inv) continue;

    const r = toNum(s.soldPrice);
    const p = toNum(inv.purchaseCost);
    const m = toNum(inv.materialCost);
    const sh = toNum(s.fees);

    revenue += r;
    purchaseCost += p;
    materialCost += m;
    shippingCost += sh;

    const alloc = allocator.allocatedExpenseForSale(s);
    materialCost += alloc.material;
    shippingCost += alloc.shipping;
    otherCost += alloc.other;
  }

  const profit = revenue - purchaseCost - materialCost - shippingCost - otherCost;

  $("#kpiRevenue") && ($("#kpiRevenue").textContent = money(revenue));
  $("#kpiPurchase") && ($("#kpiPurchase").textContent = money(purchaseCost));
  $("#kpiMaterial") && ($("#kpiMaterial").textContent = money(materialCost));
  $("#kpiShipping") && ($("#kpiShipping").textContent = money(shippingCost));
  $("#kpiOther") && ($("#kpiOther").textContent = money(otherCost));
  $("#kpiProfit") && ($("#kpiProfit").textContent = money(profit));
}

/** ---------- Inventory table ---------- */
function renderInventoryTable(viewList, allocator) {
  const tb = $("#invTbody");
  if (!tb) return;
  tb.innerHTML = "";

  const sorted = [...viewList].sort((a, b) => {
    const ad = a.purchaseDate || "0000-00-00";
    const bd = b.purchaseDate || "0000-00-00";
    if (ad !== bd) return bd.localeCompare(ad);
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  for (const inv of sorted) {
    const sold = isSoldItem(inv);
    const sale = getSaleByInventoryId(inv.id);

    const statusBadge = sold
      ? `<span class="badge sold">✅ Sold</span>`
      : `<span class="badge unsold">🕒 In Stock</span>`;

    const cond = conditionBadge(inv.condition);
    const batch = batchBadge(inv.batch);

    const itemTitle = `${inv.name || "(unnamed)"}${inv.setNumber ? ` • #${inv.setNumber}` : ""}`;

    let revenue = 0;
    let profit = 0;
    let soldOn = "—";

    if (sold && sale) {
      const net = calcSaleNet(inv, sale, allocator);
      revenue = net?.revenue || 0;
      profit = net?.profitNet || 0;
      soldOn = sale.soldOn || "—";
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div style="display:flex;gap:10px;align-items:flex-start;">
          ${renderItemThumbHTML(inv.setImageUrl)}
          <div style="display:flex;flex-direction:column;gap:6px;">
            <div style="font-weight:900;">${escapeHtml(itemTitle)}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
              ${statusBadge}
              ${cond}
              ${inv.boughtFrom ? `<span class="badge">🛒 ${escapeHtml(inv.boughtFrom)}</span>` : ""}
              ${inv.buyPayment ? `<span class="badge">💳 ${escapeHtml(inv.buyPayment)}</span>` : ""}
              ${inv.boxIncluded === "yes" ? `<span class="badge">📦 Box</span>` : `<span class="badge">📭 No Box</span>`}
              ${inv.manualIncluded === "yes" ? `<span class="badge">📘 Manual</span>` : `<span class="badge">📄 No Manual</span>`}
              ${normalizeBatch(inv.batch) ? batch : ""}
            </div>
          </div>
        </div>
      </td>

      <td class="mono">
        <div>${escapeHtml(inv.purchaseDate || "—")}</div>
        <div class="small">Buy: ${money(toNum(inv.purchaseCost))}</div>
      </td>

      <td class="mono">
        <div>${escapeHtml(sale?.soldDate || "—")}</div>
        <div class="small">${sold ? `Fees: ${money(toNum(sale?.fees))}` : ""}</div>
      </td>

      <td class="mono">${sold ? money(revenue) : "—"}</td>

      <td class="mono" style="font-weight:900;color:${profit >= 0 ? "rgba(34,197,94,0.95)" : "rgba(239,68,68,0.95)"};">
        ${sold ? money(profit) : "—"}
      </td>

      <td>${escapeHtml(soldOn)}</td>
      <td>${cond}</td>
      <td>${batch}</td>

      <td>
        <div class="rowActions">
          <button class="iconBtn" data-inv-edit="${inv.id}" title="Edit">✏️</button>
          <button class="iconBtn" data-inv-del="${inv.id}" title="Delete">🗑️</button>
          ${sold ? `<button class="iconBtn" data-sale-del="${inv.id}" title="Delete Sale">↩️</button>` : ""}
        </div>
      </td>
    `;
    tb.appendChild(tr);
  }
}

/** ---------- Charts (profit AFTER expenses) ---------- */
function renderCharts(allocator) {
  if (!window.Chart) return;

  const profitByMonth = new Map();
  for (const s of sales) {
    const key = ym(s.soldDate);
    if (!key) continue;
    const inv = inventory.find(i => i.id === s.inventoryId);
    if (!inv) continue;
    const net = calcSaleNet(inv, s, allocator);
    profitByMonth.set(key, (profitByMonth.get(key) || 0) + (net?.profitNet || 0));
  }
  const months = [...profitByMonth.keys()].sort();
  const profitVals = months.map(m => profitByMonth.get(m) || 0);

  const profitByMarket = new Map();
  for (const s of sales) {
    const inv = inventory.find(i => i.id === s.inventoryId);
    if (!inv) continue;
    const key = (s.soldOn || "").trim() || "Unknown";
    const net = calcSaleNet(inv, s, allocator);
    profitByMarket.set(key, (profitByMarket.get(key) || 0) + (net?.profitNet || 0));
  }
  const markets = [...profitByMarket.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const marketLabels = markets.map(([k]) => k);
  const marketVals = markets.map(([, v]) => v);

  const profitByCond = new Map();
  for (const s of sales) {
    const inv = inventory.find(i => i.id === s.inventoryId);
    if (!inv) continue;
    const c = normalizeCondition(inv.condition);
    const net = calcSaleNet(inv, s, allocator);
    profitByCond.set(c, (profitByCond.get(c) || 0) + (net?.profitNet || 0));
  }
  const condOrder = ["new_sealed", "new_openbox", "used_complete", "used_incomplete"];
  const condLabels = condOrder.map(k => CONDITION_LABELS[k]);
  const condVals = condOrder.map(k => profitByCond.get(k) || 0);

  const profitByBatch = new Map();
  for (const s of sales) {
    const inv = inventory.find(i => i.id === s.inventoryId);
    if (!inv) continue;
    const b = normalizeBatch(inv.batch) || "No Batch";
    const net = calcSaleNet(inv, s, allocator);
    profitByBatch.set(b, (profitByBatch.get(b) || 0) + (net?.profitNet || 0));
  }
  const batchesTop = [...profitByBatch.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const batchLabels = batchesTop.map(([k]) => k);
  const batchVals = batchesTop.map(([, v]) => v);

  const common = { color: "#e5edff", grid: "rgba(255,255,255,0.08)" };

  const lineEl = $("#profitLine");
  if (lineEl) {
    const ctx = lineEl.getContext("2d");
    if (profitLineChart) profitLineChart.destroy();
    profitLineChart = new Chart(ctx, {
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
          tooltip: { callbacks: { label: (c) => ` ${money(c.parsed.y)}` } }
        },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } }
        }
      }
    });
  }

  const marketEl = $("#marketBar");
  if (marketEl) {
    const ctx = marketEl.getContext("2d");
    if (marketBarChart) marketBarChart.destroy();
    marketBarChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: marketLabels.length ? marketLabels : ["—"],
        datasets: [{
          label: "Profit",
          data: marketLabels.length ? marketVals : [0],
          backgroundColor: (c) => (c.raw ?? 0) >= 0 ? "rgba(34,197,94,0.55)" : "rgba(239,68,68,0.55)",
          borderColor: "rgba(255,255,255,0.18)",
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: common.color } },
          tooltip: { callbacks: { label: (c) => ` ${money(c.parsed.y)}` } }
        },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } }
        }
      }
    });
  }

  const condEl = $("#conditionBar");
  if (condEl) {
    const ctx = condEl.getContext("2d");
    if (conditionBarChart) conditionBarChart.destroy();
    conditionBarChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: condLabels,
        datasets: [{
          label: "Profit",
          data: condVals,
          backgroundColor: (c) => (c.raw ?? 0) >= 0 ? "rgba(59,130,246,0.45)" : "rgba(239,68,68,0.55)",
          borderColor: "rgba(255,255,255,0.18)",
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: common.color } },
          tooltip: { callbacks: { label: (c) => ` ${money(c.parsed.y)}` } }
        },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } }
        }
      }
    });
  }

  const batchEl = $("#batchBar");
  if (batchEl) {
    const ctx = batchEl.getContext("2d");
    if (batchBarChart) batchBarChart.destroy();
    batchBarChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: batchLabels.length ? batchLabels : ["—"],
        datasets: [{
          label: "Profit",
          data: batchLabels.length ? batchVals : [0],
          backgroundColor: (c) => (c.raw ?? 0) >= 0 ? "rgba(168,85,247,0.45)" : "rgba(239,68,68,0.55)",
          borderColor: "rgba(255,255,255,0.18)",
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: common.color } },
          tooltip: { callbacks: { label: (c) => ` ${money(c.parsed.y)}` } }
        },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } }
        }
      }
    });
  }
}

/** ---------- Rerender ---------- */
function rerender() {
  const allocator = buildExpenseAllocator(sales, expenses);

  updateBatchFilter();
  updateInventoryDatalist();

  renderKPIs(allocator);
  renderCharts(allocator);

  renderExpensesTable();
  renderExpenseSummary();

  const view = getFilteredInventoryView();
  renderInventoryTable(view, allocator);
}

/** ---------- Inventory form ---------- */
function setInvFormDefaults() {
  const f = $("#invForm");
  if (!f) return;

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  if (!f.purchaseDate.value) f.purchaseDate.value = `${yyyy}-${mm}-${dd}`;

  renderThumb("", "#invPhotoPreview");
}

function clearInvForm(keepBatch = true) {
  const f = $("#invForm");
  if (!f) return;
  const batch = f.batch.value;
  f.reset();
  if (keepBatch) f.batch.value = batch;
  setInvFormDefaults();
}

async function handleInvLookup() {
  const f = $("#invForm");
  if (!f) return;
  const setNum = f.setNumber.value;
  const res = await rebrickableLookup(setNum);
  if (!res) return;

  if (res.name) f.name.value = res.name;
  if (res.img) {
    f.setImageUrl.value = res.img;
    renderThumb(res.img, "#invPhotoPreview");
  }
  toast("Set info filled ✅");
}

/** ---------- Sale form ---------- */
function setSaleFormDefaults() {
  const f = $("#saleForm");
  if (!f) return;

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  if (!f.soldDate.value) f.soldDate.value = `${yyyy}-${mm}-${dd}`;

  renderThumb("", "#salePhotoPreview");
}

function clearSaleForm() {
  const f = $("#saleForm");
  if (!f) return;
  f.reset();
  f.inventoryId.value = "";
  setSaleFormDefaults();
}

function setSaleSelection(invId) {
  const f = $("#saleForm");
  if (!f) return;

  const inv = inventory.find(i => i.id === invId);
  if (!inv) {
    f.inventoryId.value = "";
    renderThumb("", "#salePhotoPreview");
    return;
  }

  f.inventoryId.value = inv.id;
  renderThumb(inv.setImageUrl || "", "#salePhotoPreview");
}

/** ---------- Inventory edit support ---------- */
function fillInvFormForEdit(invId) {
  const inv = inventory.find(i => i.id === invId);
  if (!inv) return;

  const f = $("#invForm");
  if (!f) return;

  f.dataset.editId = inv.id;

  f.batch.value = inv.batch || "";
  f.purchaseDate.value = inv.purchaseDate || "";
  f.boughtFrom.value = inv.boughtFrom || "";
  f.buyPayment.value = inv.buyPayment || "";
  f.condition.value = normalizeCondition(inv.condition);
  f.materialCost.value = toNum(inv.materialCost);
  f.boxIncluded.value = inv.boxIncluded || "yes";
  f.manualIncluded.value = inv.manualIncluded || "yes";
  f.setNumber.value = inv.setNumber || "";
  f.name.value = inv.name || "";
  f.purchaseCost.value = toNum(inv.purchaseCost);
  f.setImageUrl.value = inv.setImageUrl || "";
  renderThumb(inv.setImageUrl || "", "#invPhotoPreview");

  toast("Editing inventory item ✏️");
  setView("viewInventory");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function saveInvEditIfNeeded(newItem) {
  const f = $("#invForm");
  const editId = f?.dataset?.editId || "";
  if (!editId) return false;

  const old = inventory.find(i => i.id === editId);
  if (!old) {
    delete f.dataset.editId;
    return false;
  }

  newItem.id = editId;
  newItem.status = old.status || "in_stock";
  newItem.createdAt = old.createdAt || Date.now();
  newItem.updatedAt = Date.now();

  await txPut(INVENTORY_STORE, newItem);
  delete f.dataset.editId;
  return true;
}

/** ---------- Inventory table actions ---------- */
async function handleInventoryTableClick(ev) {
  const invEditId = ev.target?.getAttribute?.("data-inv-edit");
  const invDelId = ev.target?.getAttribute?.("data-inv-del");
  const saleDelForInv = ev.target?.getAttribute?.("data-sale-del");

  if (invEditId) {
    fillInvFormForEdit(invEditId);
    return;
  }

  if (invDelId) {
    const inv = inventory.find(i => i.id === invDelId);
    if (!inv) return;
    const ok = confirm(`Delete "${inv.name}"? This will also delete its sale if sold.`);
    if (!ok) return;

    const sale = getSaleByInventoryId(invDelId);
    if (sale) await txDelete(SALES_STORE, sale.id);

    await txDelete(INVENTORY_STORE, invDelId);

    inventory = await txGetAll(INVENTORY_STORE);
    sales = await txGetAll(SALES_STORE);
    toast("Deleted 🗑️");
    rerender();
    return;
  }

  if (saleDelForInv) {
    const inv = inventory.find(i => i.id === saleDelForInv);
    const sale = getSaleByInventoryId(saleDelForInv);
    if (!inv || !sale) return;

    const ok = confirm(`Delete sale for "${inv.name}" and move back to In Stock?`);
    if (!ok) return;

    await txDelete(SALES_STORE, sale.id);
    inv.status = "in_stock";
    inv.updatedAt = Date.now();
    await txPut(INVENTORY_STORE, inv);

    inventory = await txGetAll(INVENTORY_STORE);
    sales = await txGetAll(SALES_STORE);
    toast("Sale removed ↩️");
    rerender();
  }
}

/** ---------- Expenses actions ---------- */
async function addExpenseFromForm(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const obj = Object.fromEntries(fd.entries());

  const exp = {
    id: uid(),
    amount: toNum(obj.amount),
    category: (obj.category || "").trim(),
    date: obj.date || "",
    note: (obj.note || "").trim(),
    createdAt: Date.now()
  };

  if (!exp.amount || exp.amount <= 0) return toast("Expense amount required.");
  if (!exp.date) return toast("Expense date required.");
  if (!exp.category) return toast("Category required.");

  await txPut(EXPENSES_STORE, exp);
  expenses = await txGetAll(EXPENSES_STORE);

  ev.target.reset();

  const d = $("#expenseForm")?.querySelector('input[name="date"]');
  if (d) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    d.value = `${yyyy}-${mm}-${dd}`;
  }

  toast("Expense added ✅");
  rerender();
}

async function handleExpensesTableClick(ev) {
  const id = ev.target?.getAttribute?.("data-exp-del");
  if (!id) return;
  await txDelete(EXPENSES_STORE, id);
  expenses = await txGetAll(EXPENSES_STORE);
  toast("Expense deleted 🗑️");
  rerender();
}

async function clearExpenses() {
  const ok = confirm("Clear all expenses? This cannot be undone.");
  if (!ok) return;
  await txClear(EXPENSES_STORE);
  expenses = await txGetAll(EXPENSES_STORE);
  toast("Expenses cleared 🗑️");
  rerender();
}

/** ---------- Export / Import ---------- */
function parseCSV(text) {
  // Handles commas + quoted fields
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') { // escaped quote
      cur += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      row.push(cur);
      cur = "";
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.some(c => c.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    cur += ch;
  }
  row.push(cur);
  if (row.some(c => c.trim() !== "")) rows.push(row);

  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(cols => {
    const obj = {};
    headers.forEach((h, idx) => obj[h] = (cols[idx] ?? "").trim());
    return obj;
  });
}

function csvBool(v) {
  const s = (v || "").trim().toLowerCase();
  if (!s) return "yes";
  if (["y","yes","true","1"].includes(s)) return "yes";
  if (["n","no","false","0"].includes(s)) return "no";
  return "yes";
}

async function importInventoryCSV(file) {
  const text = await file.text();
  const rows = parseCSV(text);
  if (!rows.length) return toast("CSV has no rows.");

  let added = 0;
  for (const r of rows) {
    const purchaseDate = r.purchaseDate || r.purchase_date || "";
    const name = (r.name || "").trim();
    const setNumber = (r.setNumber || r.set_number || "").trim();

    const purchaseCost = toNum(r.purchaseCost ?? r.purchase_cost);
    if (!purchaseDate || !name || purchaseCost <= 0) continue;

    const item = {
      id: uid(),
      name,
      setNumber,
      setImageUrl: (r.setImageUrl || r.set_image_url || "").trim(),
      purchaseDate,
      purchaseCost,
      materialCost: toNum(r.materialCost ?? r.material_cost),
      condition: normalizeCondition(r.condition),
      batch: normalizeBatch(r.batch),
      boughtFrom: (r.boughtFrom || r.bought_from || "").trim(),
      buyPayment: (r.buyPayment || r.buy_payment || "").trim(),
      boxIncluded: csvBool(r.boxIncluded ?? r.box_included),
      manualIncluded: csvBool(r.manualIncluded ?? r.manual_included),
      status: "in_stock",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await txPut(INVENTORY_STORE, item);
    added++;
  }

  inventory = await txGetAll(INVENTORY_STORE);
  toast(`Imported ${added} inventory items ✅`);
  rerender();
}



async function exportData() {
  const payload = {
    exportedAt: new Date().toISOString(),
    inventory: await txGetAll(INVENTORY_STORE),
    sales: await txGetAll(SALES_STORE),
    expenses: await txGetAll(EXPENSES_STORE)
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `lego-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Exported 📦");
}

async function importData(file) {
  const text = await file.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { toast("Invalid JSON file."); return; }

  const inv = parsed?.inventory;
  const sal = parsed?.sales;
  const exp = parsed?.expenses;

  if (!Array.isArray(inv) && !Array.isArray(sal) && !Array.isArray(exp)) {
    toast("No inventory/sales/expenses found in file.");
    return;
  }

  if (Array.isArray(inv)) {
    for (const raw of inv) {
      const item = {
        id: raw.id || uid(),
        name: (raw.name || "").trim(),
        setNumber: (raw.setNumber || "").trim(),
        setImageUrl: (raw.setImageUrl || "").trim(),
        purchaseDate: raw.purchaseDate || "",
        purchaseCost: toNum(raw.purchaseCost),
        materialCost: toNum(raw.materialCost),
        condition: normalizeCondition(raw.condition),
        batch: normalizeBatch(raw.batch),
        boughtFrom: (raw.boughtFrom || "").trim(),
        buyPayment: (raw.buyPayment || "").trim(),
        boxIncluded: (raw.boxIncluded || "yes"),
        manualIncluded: (raw.manualIncluded || "yes"),
        status: (raw.status === "sold") ? "sold" : "in_stock",
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      if (!item.name || !item.purchaseDate) continue;
      await txPut(INVENTORY_STORE, item);
    }
  }

  if (Array.isArray(sal)) {
    for (const raw of sal) {
      const sale = {
        id: raw.id || uid(),
        inventoryId: (raw.inventoryId || "").trim(),
        soldDate: raw.soldDate || "",
        soldPrice: toNum(raw.soldPrice),
        fees: toNum(raw.fees),
        soldOn: (raw.soldOn || "").trim(),
        sellPayment: (raw.sellPayment || "").trim(),
        notes: (raw.notes || "").trim(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      if (!sale.inventoryId || !sale.soldDate || sale.soldPrice <= 0) continue;
      await txPut(SALES_STORE, sale);
    }
  }

  if (Array.isArray(exp)) {
    for (const raw of exp) {
      const e = {
        id: raw.id || uid(),
        amount: toNum(raw.amount),
        category: (raw.category || "").trim() || "Other",
        date: raw.date || "",
        note: (raw.note || "").trim(),
        createdAt: Date.now()
      };
      if (!e.date || e.amount <= 0) continue;
      await txPut(EXPENSES_STORE, e);
    }
  }

  inventory = await txGetAll(INVENTORY_STORE);
  sales = await txGetAll(SALES_STORE);
  expenses = await txGetAll(EXPENSES_STORE);

  const soldIds = new Set(sales.map(s => s.inventoryId));
  for (const i of inventory) {
    const shouldSold = soldIds.has(i.id);
    const newStatus = shouldSold ? "sold" : "in_stock";
    if (i.status !== newStatus) {
      i.status = newStatus;
      i.updatedAt = Date.now();
      await txPut(INVENTORY_STORE, i);
    }
  }
  inventory = await txGetAll(INVENTORY_STORE);

  toast("Imported ✅");
  rerender();
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

/** ---------- Legacy migration (run ONCE) ---------- */
const MIGRATION_FLAG = "lego_migrated_flips_to_inventory_v1";

async function migrateOldFlipsIfAny() {
  // If we've already migrated once, never do it again
  if (localStorage.getItem(MIGRATION_FLAG) === "1") return;

  const hasOld = await storeExists(OLD_FLIPS_STORE);
  if (!hasOld) {
    // Nothing to migrate, but mark as done so it never tries again
    localStorage.setItem(MIGRATION_FLAG, "1");
    return;
  }

  // Only migrate if new stores are empty (first time setup)
  const existingInv = await txGetAll(INVENTORY_STORE);
  const existingSales = await txGetAll(SALES_STORE);

  if (existingInv.length || existingSales.length) {
    // New system already in use; don't ever try again
    localStorage.setItem(MIGRATION_FLAG, "1");
    return;
  }

  const db = await openDB();
  const oldFlips = await new Promise((resolve) => {
    try {
      const tx = db.transaction(OLD_FLIPS_STORE, "readonly");
      const store = tx.objectStore(OLD_FLIPS_STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
      tx.oncomplete = () => db.close();
    } catch {
      db.close();
      resolve([]);
    }
  });

  if (!oldFlips.length) {
    localStorage.setItem(MIGRATION_FLAG, "1");
    return;
  }

  for (const f of oldFlips) {
    const inv = {
      id: f.id || uid(),
      name: (f.name || "").trim(),
      setNumber: (f.setNumber || "").trim(),
      setImageUrl: (f.setImageUrl || "").trim(),
      purchaseDate: f.purchaseDate || "",
      purchaseCost: toNum(f.purchaseCost),
      materialCost: toNum(f.materialCost),
      condition: normalizeCondition(f.condition),
      batch: normalizeBatch(f.batch),
      boughtFrom: (f.boughtFrom || "").trim(),
      buyPayment: (f.buyPayment || "").trim(),
      boxIncluded: (f.boxIncluded || "yes"),
      manualIncluded: (f.manualIncluded || "yes"),
      status: (f.soldDate && toNum(f.soldPrice) > 0) ? "sold" : "in_stock",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    if (inv.name && inv.purchaseDate) await txPut(INVENTORY_STORE, inv);

    if (inv.status === "sold") {
      const sale = {
        id: uid(),
        inventoryId: inv.id,
        soldDate: f.soldDate || "",
        soldPrice: toNum(f.soldPrice),
        fees: toNum(f.fees),
        soldOn: (f.soldOn || "").trim(),
        sellPayment: (f.sellPayment || "").trim(),
        notes: (f.notes || "").trim(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      if (sale.soldDate && sale.soldPrice > 0) await txPut(SALES_STORE, sale);
    }
  }

  localStorage.setItem(MIGRATION_FLAG, "1");
  toast("Migrated old flips ✅");
}


/** ---------- Init ---------- */


async function init() {
  // Tabs
  $("#topTabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".tabBtn");
    if (!btn) return;
    setView(btn.dataset.view);
  });
  setView("viewInventory");

  // Defaults
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  $("#invForm")?.querySelector('input[name="purchaseDate"]')?.setAttribute("value", `${yyyy}-${mm}-${dd}`);
  $("#saleForm")?.querySelector('input[name="soldDate"]')?.setAttribute("value", `${yyyy}-${mm}-${dd}`);
  $("#expenseForm")?.querySelector('input[name="date"]')?.setAttribute("value", `${yyyy}-${mm}-${dd}`);

  // Header buttons
  $("#apiKeyBtn")?.addEventListener("click", async () => {
    const current = getRBKey();
    const entered = prompt("Rebrickable API key (stored locally in your browser):", current);
    if (entered === null) return;
    setRBKey(entered);
    toast(getRBKey() ? "API key saved ✅" : "API key cleared");
  });

  $("#invLookupBtn")?.addEventListener("click", handleInvLookup);

  $("#exportBtn")?.addEventListener("click", exportData);
  $("#importInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await importData(file);
    e.target.value = "";
  });

  $("#importCsvInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await importInventoryCSV(file);
    e.target.value = "";
  });


  // Inventory submit (supports edit mode)
  $("#invForm")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const fd = new FormData(f);
    const obj = Object.fromEntries(fd.entries());

    const base = {
      id: uid(),
      name: (obj.name || "").trim(),
      setNumber: (obj.setNumber || "").trim(),
      setImageUrl: (obj.setImageUrl || "").trim(),
      purchaseDate: obj.purchaseDate || "",
      purchaseCost: toNum(obj.purchaseCost),
      materialCost: toNum(obj.materialCost),
      condition: normalizeCondition(obj.condition),
      batch: normalizeBatch(obj.batch),
      boughtFrom: (obj.boughtFrom || "").trim(),
      buyPayment: (obj.buyPayment || "").trim(),
      boxIncluded: (obj.boxIncluded || "yes"),
      manualIncluded: (obj.manualIncluded || "yes"),
      status: "in_stock",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    if (!base.name) return toast("Name is required.");
    if (!base.purchaseDate) return toast("Purchase date is required.");
    if (!base.purchaseCost || base.purchaseCost <= 0) return toast("Purchase cost required.");

    const didEdit = await saveInvEditIfNeeded(base);
    if (!didEdit) await txPut(INVENTORY_STORE, base);

    inventory = await txGetAll(INVENTORY_STORE);
    toast(didEdit ? "Inventory updated ✅" : "Added to inventory ✅");
    clearInvForm(true);
    rerender();
  });

  $("#invResetBtn")?.addEventListener("click", () => {
    const f = $("#invForm");
    if (f?.dataset?.editId) delete f.dataset.editId;
    clearInvForm(true);
  });

  // Sale
  $("#saleForm")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const fd = new FormData(f);
    const obj = Object.fromEntries(fd.entries());

    const invId = (obj.inventoryId || "").trim();
    if (!invId) return toast("Select an inventory item first.");

    const inv = inventory.find(i => i.id === invId);
    if (!inv) return toast("Selected item not found.");
    if (inv.status === "sold") return toast("That item is already sold.");

    const soldDate = obj.soldDate || "";
    const soldPrice = toNum(obj.soldPrice);
    const fees = toNum(obj.fees);

    if (!soldDate) return toast("Sold date required.");
    if (!soldPrice || soldPrice <= 0) return toast("Sold price required.");

    const sale = {
      id: uid(),
      inventoryId: invId,
      soldDate,
      soldPrice,
      fees,
      soldOn: (obj.soldOn || "").trim(),
      sellPayment: (obj.sellPayment || "").trim(),
      notes: (obj.notes || "").trim(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await txPut(SALES_STORE, sale);

    inv.status = "sold";
    inv.updatedAt = Date.now();
    await txPut(INVENTORY_STORE, inv);

    inventory = await txGetAll(INVENTORY_STORE);
    sales = await txGetAll(SALES_STORE);

    toast("Sale saved ✅");
    clearSaleForm();
    rerender();
  });

  $("#saleResetBtn")?.addEventListener("click", clearSaleForm);

  $("#invPick")?.addEventListener("input", (e) => {
    const id = resolveInventoryPickToId(e.target.value);
    const f = $("#saleForm");
    if (!f) return;
    f.inventoryId.value = id || "";
    setSaleSelection(id);
  });

  // Filters
  $("#searchInput")?.addEventListener("input", rerender);
  $("#statusFilter")?.addEventListener("change", rerender);
  $("#conditionFilter")?.addEventListener("change", rerender);
  $("#batchFilter")?.addEventListener("change", rerender);

  // Expenses
  $("#expenseForm")?.addEventListener("submit", addExpenseFromForm);
  $("#expenseTbody")?.addEventListener("click", handleExpensesTableClick);
  $("#clearExpensesBtn")?.addEventListener("click", clearExpenses);

  // Table row actions
  $("#invTbody")?.addEventListener("click", handleInventoryTableClick);

  setupInstallFlow();
  await registerSW();

  await migrateOldFlipsIfAny();

  inventory = await txGetAll(INVENTORY_STORE);
  sales = await txGetAll(SALES_STORE);
  expenses = await txGetAll(EXPENSES_STORE);

  // Ensure statuses match sales
  const soldIds = new Set(sales.map(s => s.inventoryId));
  for (const i of inventory) {
    const shouldSold = soldIds.has(i.id);
    const newStatus = shouldSold ? "sold" : "in_stock";
    if (i.status !== newStatus) {
      i.status = newStatus;
      i.updatedAt = Date.now();
      await txPut(INVENTORY_STORE, i);
    }
  }
  inventory = await txGetAll(INVENTORY_STORE);

  setInvFormDefaults();
  setSaleFormDefaults();
  rerender();

  // Chart.js may load a moment later
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (window.Chart) {
      clearInterval(t);
      rerender();
    }
    if (tries > 40) clearInterval(t);
  }, 100);
}

init();

