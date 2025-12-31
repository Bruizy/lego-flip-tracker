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

/** ---------- Rebrickable ---------- */
const RB_KEY_STORAGE = "rebrickable_api_key";

function getRBKey() {
  return (localStorage.getItem(RB_KEY_STORAGE) || "").trim();
}
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
  if (!key) {
    toast("No API key set.");
    return null;
  }

  const setNum = normalizeSetNumberForRB(setNumberRaw);
  if (!setNum) {
    toast("Type a set number first.");
    return null;
  }

  const url = `https://rebrickable.com/api/v3/lego/sets/${encodeURIComponent(setNum)}/?key=${encodeURIComponent(key)}`;

  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        toast("API key rejected. Click API Key and try again.");
        return null;
      }
      toast(`Lookup failed (${res.status}).`);
      return null;
    }
    const data = await res.json();
    return {
      name: data?.name || "",
      img: data?.set_img_url || ""
    };
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
function normalizeBatch(v) {
  return (v || "").trim();
}
function batchBadge(batch) {
  const b = normalizeBatch(batch);
  if (!b) return `<span class="small">—</span>`;
  return `<span class="badge batch">📦 ${escapeHtml(b)}</span>`;
}

/** ---------- Expenses: Category -> Cost Bucket ---------- */
/**
 * You wanted: expenses affect TOTAL profit + graphs, but by bucket:
 * - Material bucket: Supplies, Parts
 * - Shipping bucket: Shipping
 * - Other bucket: Gas, Fees (other), Other
 */
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
const DB_VERSION = 2; // expenses store
const STORE = "flips";
const EXPENSES_STORE = "expenses";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      // Flips store
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("purchaseDate", "purchaseDate");
        store.createIndex("soldDate", "soldDate");
        store.createIndex("name", "name");
        store.createIndex("batch", "batch");
        store.createIndex("setNumber", "setNumber");
      } else {
        const tx = req.transaction;
        const store = tx.objectStore(STORE);
        if (!store.indexNames.contains("purchaseDate")) store.createIndex("purchaseDate", "purchaseDate");
        if (!store.indexNames.contains("soldDate")) store.createIndex("soldDate", "soldDate");
        if (!store.indexNames.contains("name")) store.createIndex("name", "name");
        if (!store.indexNames.contains("batch")) store.createIndex("batch", "batch");
        if (!store.indexNames.contains("setNumber")) store.createIndex("setNumber", "setNumber");
      }

      // Expenses store
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

/** ---------- Expenses DB helpers ---------- */
async function txReadAllExpenses() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EXPENSES_STORE, "readonly");
    const store = tx.objectStore(EXPENSES_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function txPutExpense(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EXPENSES_STORE, "readwrite");
    const store = tx.objectStore(EXPENSES_STORE);
    const req = store.put(item);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function txDeleteExpense(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EXPENSES_STORE, "readwrite");
    const store = tx.objectStore(EXPENSES_STORE);
    const req = store.delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function txClearExpenses() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EXPENSES_STORE, "readwrite");
    const store = tx.objectStore(EXPENSES_STORE);
    const req = store.clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/** ---------- Domain logic ---------- */
function isSold(item) {
  const soldPrice = toNum(item.soldPrice);
  return !!item.soldDate && soldPrice > 0;
}

/**
 * Direct per-flip numbers (does NOT include global expenses)
 */
function calcFlip(item) {
  const purchase = toNum(item.purchaseCost);
  const material = toNum(item.materialCost);
  const shipping = toNum(item.fees);
  const revenue = toNum(item.soldPrice);
  const directCost = purchase + material + shipping;
  const profit = revenue - directCost;
  return { revenue, purchase, material, shipping, directCost, profit, sold: isSold(item) };
}

/**
 * Build monthly expense buckets
 */
function expenseBucketsByMonth(expenses) {
  const byMonth = new Map(); // ym -> { material, shipping, other, total }
  for (const e of expenses) {
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

/**
 * Allocate monthly expenses to sold flips in that same sold-month, proportionally by revenue.
 * This makes profit charts + marketplace/condition/batch totals consistent.
 */
function buildExpenseAllocator(flips, expenses) {
  const expByMonth = expenseBucketsByMonth(expenses);

  // Precompute sold revenue totals by month
  const soldRevByMonth = new Map(); // ym -> total revenue
  const soldCountByMonth = new Map(); // ym -> count sold
  for (const f of flips) {
    if (!isSold(f)) continue;
    const key = ym(f.soldDate);
    if (!key) continue;
    const rev = toNum(f.soldPrice);
    soldRevByMonth.set(key, (soldRevByMonth.get(key) || 0) + rev);
    soldCountByMonth.set(key, (soldCountByMonth.get(key) || 0) + 1);
  }

  function allocatedExpenseForFlip(flip) {
    if (!isSold(flip)) return { material: 0, shipping: 0, other: 0, total: 0 };

    const key = ym(flip.soldDate);
    if (!key) return { material: 0, shipping: 0, other: 0, total: 0 };

    const monthExp = expByMonth.get(key);
    if (!monthExp) return { material: 0, shipping: 0, other: 0, total: 0 };

    const totalRev = soldRevByMonth.get(key) || 0;
    const count = soldCountByMonth.get(key) || 0;
    const rev = toNum(flip.soldPrice);

    // If revenue sum is 0 (rare), split evenly among sold flips that month.
    const share = totalRev > 0 ? (rev / totalRev) : (count > 0 ? 1 / count : 0);

    return {
      material: monthExp.material * share,
      shipping: monthExp.shipping * share,
      other: monthExp.other * share,
      total: monthExp.total * share
    };
  }

  return { expByMonth, allocatedExpenseForFlip };
}

/**
 * Full profit for flip including allocated expenses
 */
function calcNet(flip, allocator) {
  const base = calcFlip(flip);
  const alloc = allocator.allocatedExpenseForFlip(flip);
  const profit = base.profit - alloc.total;
  return { ...base, alloc, profitNet: profit };
}

function normalizeFormData(fd) {
  const obj = Object.fromEntries(fd.entries());
  return {
    id: obj.id || uid(),
    name: (obj.name || "").trim(),
    setNumber: (obj.setNumber || "").trim(),
    setImageUrl: (obj.setImageUrl || "").trim(),
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
    updatedAt: Date.now(),
    boxIncluded: (obj.boxIncluded || "yes"),
    manualIncluded: (obj.manualIncluded || "yes")
  };
}

/** ---------- Rendering ---------- */
let allFlips = [];
let allExpenses = [];

let profitLineChart = null;
let marketBarChart = null;
let conditionBarChart = null;
let batchBarChart = null;

function renderItemThumb(url) {
  const u = (url || "").trim();
  if (!u) return "";
  const safe = escapeHtml(u);
  return `
    <a href="${safe}" target="_blank" rel="noopener">
      <img class="thumb clickable" src="${safe}" alt="set" loading="lazy" />
    </a>
  `;
}

function renderTable(list, allocator) {
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
    const base = calcFlip(item);
    const net = calcNet(item, allocator);

    const tr = document.createElement("tr");
    const itemTitle = `${item.name || "(unnamed)"}${item.setNumber ? ` • #${item.setNumber}` : ""}`;
    const statusBadge = base.sold
      ? `<span class="badge sold">✅ Sold</span>`
      : `<span class="badge unsold">🕒 Unsold</span>`;

    const cond = conditionBadge(item.condition);
    const batch = batchBadge(item.batch);

    // Table keeps "Costs" column as DIRECT cost (purchase+perflip material+perflip shipping)
    // Profit column shows PROFIT AFTER ALLOCATED EXPENSES (what you asked)
    tr.innerHTML = `
      <td>
        <div style="display:flex;gap:10px;align-items:flex-start;">
          ${renderItemThumb(item.setImageUrl)}
          <div style="display:flex;flex-direction:column;gap:6px;">
            <div style="font-weight:900;">${escapeHtml(itemTitle)}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
              ${statusBadge}
              ${cond}
              ${item.boughtFrom ? `<span class="badge">🛒 ${escapeHtml(item.boughtFrom)}</span>` : ""}
              ${item.buyPayment ? `<span class="badge">💳 ${escapeHtml(item.buyPayment)}</span>` : ""}
              ${item.boxIncluded === "yes" ? `<span class="badge">📦 Box</span>` : `<span class="badge">📭 No Box</span>`}
              ${item.manualIncluded === "yes" ? `<span class="badge">📘 Manual</span>` : `<span class="badge">📄 No Manual</span>`}
              ${normalizeBatch(item.batch) ? batch : ""}
            </div>
            ${item.notes ? `<div class="small">${escapeHtml(item.notes)}</div>` : ""}
          </div>
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

      <td class="mono">${money(base.directCost)}</td>
      <td class="mono">${money(base.revenue)}</td>

      <td class="mono" style="font-weight:900;color:${net.profitNet >= 0 ? "rgba(34,197,94,0.95)" : "rgba(239,68,68,0.95)"};">
        ${money(net.profitNet)}
      </td>

      <td class="mono">${base.directCost > 0 ? `${((net.profitNet / base.directCost) * 100).toFixed(1)}%` : "0.0%"}</td>

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

function renderExpensesTable(expenses) {
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
      <td>
        <div class="rowActions">
          <button class="iconBtn" data-exp-del="${e.id}" title="Delete">🗑️</button>
        </div>
      </td>
    `;
    tb.appendChild(tr);
  }
}

/**
 * Expense card: show totals by CATEGORY only (no net profit, no total)
 * If you added <div id="expenseSummary"></div> in index.html, it will render.
 */
function renderExpenseSummary(expenses) {
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

/**
 * KPIs:
 * Revenue, Purchase Cost, Material Cost, Shipping Cost, Other Cost, Profit
 * Profit = revenue - (purchase + material + shipping + other)
 * Expenses are bucketed into material/shipping/other.
 *
 * IMPORTANT:
 * These IDs must exist in index.html:
 * - kpiRevenue, kpiPurchase, kpiMaterial, kpiShipping, kpiOther, kpiProfit
 *
 * If you haven't updated index.html yet, this won't show correctly.
 */
function renderKPIs(flipsList, allocator) {
  let revenue = 0;
  let purchaseCost = 0;
  let materialCost = 0;
  let shippingCost = 0;
  let otherCost = 0;

  // Per-flip direct amounts
  for (const item of flipsList) {
    const base = calcFlip(item);
    revenue += base.revenue;
    purchaseCost += base.purchase;
    materialCost += base.material;
    shippingCost += base.shipping;

    // allocated expenses per sold flip -> bucketed
    const alloc = allocator.allocatedExpenseForFlip(item);
    materialCost += alloc.material;
    shippingCost += alloc.shipping;
    otherCost += alloc.other;
  }

  const profit = revenue - purchaseCost - materialCost - shippingCost - otherCost;

  // New KPIs
  $("#kpiRevenue") && ($("#kpiRevenue").textContent = money(revenue));
  $("#kpiPurchase") && ($("#kpiPurchase").textContent = money(purchaseCost));
  $("#kpiMaterial") && ($("#kpiMaterial").textContent = money(materialCost));
  $("#kpiShipping") && ($("#kpiShipping").textContent = money(shippingCost));
  $("#kpiOther") && ($("#kpiOther").textContent = money(otherCost));
  $("#kpiProfit") && ($("#kpiProfit").textContent = money(profit));

  // Backward-compat: if old elements exist, try not to lie.
  // We blank ROI/costs if present to avoid confusion.
  $("#kpiCosts") && ($("#kpiCosts").textContent = "—");
  $("#kpiROI") && ($("#kpiROI").textContent = "—");
  $("#kpiExpenses") && ($("#kpiExpenses").textContent = "—");
  $("#kpiNetProfit") && ($("#kpiNetProfit").textContent = "—");
}

function updateBatchUIFromAllFlips(flips) {
  const batches = [...new Set(flips.map(f => normalizeBatch(f.batch)).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const dl = $("#batchList");
  if (dl) dl.innerHTML = batches.map(b => `<option value="${escapeHtml(b)}"></option>`).join("");

  const bf = $("#batchFilter");
  if (bf) {
    const current = bf.value || "all";
    bf.innerHTML = [
      `<option value="all">All Batches</option>`,
      ...batches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`)
    ].join("");
    if ([...bf.options].some(o => o.value === current)) bf.value = current;
    else bf.value = "all";
  }
}

function renderCharts(flipsList, allocator) {
  if (!window.Chart) return;

  // ---- Profit over time (profit AFTER expenses, month-by-month) ----
  const profitByMonth = new Map();
  for (const item of flipsList) {
    const key = ym(item.soldDate);
    if (!key) continue;
    const { profitNet } = calcNet(item, allocator);
    profitByMonth.set(key, (profitByMonth.get(key) || 0) + profitNet);
  }
  const months = [...profitByMonth.keys()].sort();
  const profitVals = months.map(m => profitByMonth.get(m) || 0);

  // ---- Profit by marketplace (sold only) AFTER expenses allocation ----
  const profitByMarket = new Map();
  for (const item of flipsList) {
    if (!isSold(item)) continue;
    const market = (item.soldOn || "").trim() || "Unknown";
    const { profitNet } = calcNet(item, allocator);
    profitByMarket.set(market, (profitByMarket.get(market) || 0) + profitNet);
  }
  const markets = [...profitByMarket.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const marketLabels = markets.map(([k]) => k);
  const marketVals = markets.map(([, v]) => v);

  // ---- Profit by condition (sold only) AFTER expenses allocation ----
  const profitByCond = new Map();
  for (const item of flipsList) {
    if (!isSold(item)) continue;
    const c = normalizeCondition(item.condition);
    const { profitNet } = calcNet(item, allocator);
    profitByCond.set(c, (profitByCond.get(c) || 0) + profitNet);
  }
  const condOrder = ["new_sealed", "new_openbox", "used_complete", "used_incomplete"];
  const condLabels = condOrder.map(k => CONDITION_LABELS[k]);
  const condVals = condOrder.map(k => profitByCond.get(k) || 0);

  // ---- Profit by batch (sold only) AFTER expenses allocation ----
  const profitByBatch = new Map();
  for (const item of flipsList) {
    if (!isSold(item)) continue;
    const b = normalizeBatch(item.batch) || "No Batch";
    const { profitNet } = calcNet(item, allocator);
    profitByBatch.set(b, (profitByBatch.get(b) || 0) + profitNet);
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
    const sold = isSold(item);

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
  const flipsView = getFiltered();
  const allocator = buildExpenseAllocator(allFlips, allExpenses);

  renderTable(flipsView, allocator);
  renderKPIs(flipsView, allocator);
  renderCharts(flipsView, allocator);

  renderExpenseSummary(allExpenses);
}

/** ---------- Form actions ---------- */
function setPreview(url) {
  const img = $("#setPhotoPreview");
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

function setForm(item) {
  const f = $("#flipForm");
  if (!f) return;

  f.id.value = item?.id || "";
  f.name.value = item?.name || "";
  f.setNumber.value = item?.setNumber || "";
  f.setImageUrl.value = item?.setImageUrl || "";
  setPreview(item?.setImageUrl || "");

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
  f.boxIncluded.value = item?.boxIncluded || "yes";
  f.manualIncluded.value = item?.manualIncluded || "yes";
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

  await txPutExpense(exp);
  allExpenses = await txReadAllExpenses();
  renderExpensesTable(allExpenses);
  rerender();
  ev.target.reset();

  // set default date again (quality of life)
  const d = $("#expenseForm")?.querySelector('input[name="date"]');
  if (d) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    d.value = `${yyyy}-${mm}-${dd}`;
  }

  toast("Expense added ✅");
}

async function handleExpensesTableClick(ev) {
  const id = ev.target?.getAttribute?.("data-exp-del");
  if (!id) return;
  await txDeleteExpense(id);
  allExpenses = await txReadAllExpenses();
  renderExpensesTable(allExpenses);
  rerender();
  toast("Expense deleted 🗑️");
}

async function clearExpenses() {
  const ok = confirm("Clear all expenses? This cannot be undone.");
  if (!ok) return;
  await txClearExpenses();
  allExpenses = await txReadAllExpenses();
  renderExpensesTable(allExpenses);
  rerender();
  toast("Expenses cleared 🗑️");
}

/** ---------- Export / Import ---------- */
async function exportData() {
  const flips = await txReadAll();
  const expenses = await txReadAllExpenses();

  const payload = {
    exportedAt: new Date().toISOString(),
    flips,
    expenses
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `lego-flips-backup-${new Date().toISOString().slice(0, 10)}.json`;
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

  for (const raw of flips) {
    const item = {
      id: raw.id || uid(),
      name: (raw.name || "").trim(),
      setNumber: (raw.setNumber || "").trim(),
      setImageUrl: (raw.setImageUrl || "").trim(),
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
      updatedAt: Date.now(),
      boxIncluded: (raw.boxIncluded || "yes"),
      manualIncluded: (raw.manualIncluded || "yes")
    };
    if (!item.name || !item.purchaseDate) continue;
    await txPut(item);
  }

  // Expenses import (optional/backward compatible)
  const expenses = parsed?.expenses;
  if (Array.isArray(expenses)) {
    for (const raw of expenses) {
      const exp = {
        id: raw.id || uid(),
        amount: toNum(raw.amount),
        category: (raw.category || "").trim() || "Other",
        date: raw.date || "",
        note: (raw.note || "").trim(),
        createdAt: Date.now()
      };
      if (!exp.amount || exp.amount <= 0) continue;
      if (!exp.date) continue;
      await txPutExpense(exp);
    }
  }

  allFlips = await txReadAll();
  updateBatchUIFromAllFlips(allFlips);

  allExpenses = await txReadAllExpenses();
  renderExpensesTable(allExpenses);

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
  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (e) {
    console.warn("SW registration failed:", e);
  }
}

/** ---------- Init ---------- */
async function init() {
  const form = $("#flipForm");
  if (!form) return;

  // default dates
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  form.purchaseDate.value = `${yyyy}-${mm}-${dd}`;

  const expDate = $("#expenseForm")?.querySelector('input[name="date"]');
  if (expDate) expDate.value = `${yyyy}-${mm}-${dd}`;

  // Buttons
  $("#apiKeyBtn")?.addEventListener("click", async () => {
    const current = getRBKey();
    const entered = prompt("Rebrickable API key (stored locally in your browser):", current);
    if (entered === null) return;
    setRBKey(entered);
    toast(getRBKey() ? "API key saved ✅" : "API key cleared");
  });

  $("#lookupBtn")?.addEventListener("click", async () => {
    const setNum = form.setNumber.value;
    const res = await rebrickableLookup(setNum);
    if (!res) return;

    if (res.name) form.name.value = res.name;
    if (res.img) {
      form.setImageUrl.value = res.img;
      setPreview(res.img);
    }
    toast("Set info filled ✅");
  });

  // Flip actions
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

  // Expenses actions
  $("#expenseForm")?.addEventListener("submit", addExpenseFromForm);
  $("#expenseTbody")?.addEventListener("click", handleExpensesTableClick);
  $("#clearExpensesBtn")?.addEventListener("click", clearExpenses);

  setupInstallFlow();
  await registerSW();

  // Load flips
  allFlips = await txReadAll();

  // Normalize old records
  let changed = false;
  for (const item of allFlips) {
    const c = normalizeCondition(item.condition);
    if (item.condition !== c) { item.condition = c; changed = true; }
    if (typeof item.batch !== "string") { item.batch = ""; changed = true; }
    if (typeof item.setImageUrl !== "string") { item.setImageUrl = ""; changed = true; }
    if (item.boxIncluded !== "yes" && item.boxIncluded !== "no") { item.boxIncluded = "yes"; changed = true; }
    if (item.manualIncluded !== "yes" && item.manualIncluded !== "no") { item.manualIncluded = "yes"; changed = true; }
    if (changed) { item.updatedAt = Date.now(); await txPut(item); }
    changed = false;
  }
  allFlips = await txReadAll();
  updateBatchUIFromAllFlips(allFlips);

  // Load expenses
  allExpenses = await txReadAllExpenses();
  renderExpensesTable(allExpenses);

  // Hide preview initially
  setPreview("");

  rerender();

  // charts might load slightly after Chart.js
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (window.Chart) {
      clearInterval(t);
      // rerender already draws charts; this makes sure Chart.js is ready
      rerender();
    }
    if (tries > 40) clearInterval(t);
  }, 100);
}

init();

