/* app.js */
"use strict";

/** =======================
 *  Utilities
 *  ======================= */
const $ = (sel) => document.querySelector(sel);

const toNum = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  // allow "$1,234.56"
  const s = String(v).trim().replace(/\$/g, "").replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

const money = (n) => {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
};

const pct = (n) => `${(Number.isFinite(n) ? n : 0).toFixed(1)}%`;

const uid = () =>
  crypto.randomUUID?.() ?? `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;

const ym = (dateStr) => {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  return dateStr.slice(0, 7);
};

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

function daysBetween(dateA, dateB) {
  if (!dateA || !dateB) return null;
  const a = new Date(dateA);
  const b = new Date(dateB);
  if (isNaN(a) || isNaN(b)) return null;
  const ms = b - a;
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / (1000 * 60 * 60 * 24)));
}

/** =======================
 *  Rebrickable
 *  ======================= */
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
  if (!key) return null;

  const setNum = normalizeSetNumberForRB(setNumberRaw);
  if (!setNum) return null;

  const url = `https://rebrickable.com/api/v3/lego/sets/${encodeURIComponent(setNum)}/?key=${encodeURIComponent(
    key
  )}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      name: data?.name || "",
      img: data?.set_img_url || "",
    };
  } catch {
    return null;
  }
}

/** =======================
 *  Constants / Labels
 *  ======================= */
const CONDITION_LABELS = {
  new_sealed: "New (sealed)",
  new_openbox: "New (open box)",
  used_complete: "Used (complete)",
  used_incomplete: "Used (incomplete)",
};

function normalizeCondition(v) {
  const key = (v || "").trim();
  return CONDITION_LABELS[key] ? key : "used_incomplete";
}

function conditionBadge(key) {
  const k = normalizeCondition(key);
  const emoji =
    {
      new_sealed: "🟩",
      new_openbox: "🟨",
      used_complete: "🟦",
      used_incomplete: "🟧",
    }[k] || "🟧";
  return `<span class="badge cond">${emoji} ${escapeHtml(CONDITION_LABELS[k])}</span>`;
}

function normalizeBatch(v) {
  return (v || "").trim();
}
function batchBadge(batch) {
  const b = normalizeBatch(batch);
  if (!b) return `<span class="small">—</span>`;
  return `<span class="badge batch">📦 ${escapeHtml(b)}</span>`;
}

function renderThumb(url) {
  const u = (url || "").trim();
  if (!u) return "";
  const safe = escapeHtml(u);
  // NOTE: user asked not clickable earlier; keep non-clickable for simplicity
  return `<img class="thumb" src="${safe}" alt="set" loading="lazy" />`;
}

/** =======================
 *  IndexedDB
 *  ======================= */
const DB_NAME = "legoFlipDB2";
const DB_VERSION = 1;

const INVENTORY_STORE = "inventory";
const SALES_STORE = "sales";
const EXPENSES_STORE = "expenses";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      // Inventory
      if (!db.objectStoreNames.contains(INVENTORY_STORE)) {
        const s = db.createObjectStore(INVENTORY_STORE, { keyPath: "id" });
        s.createIndex("purchaseDate", "purchaseDate");
        s.createIndex("status", "status");
        s.createIndex("batch", "batch");
        s.createIndex("setNumber", "setNumber");
        s.createIndex("name", "name");
      }

      // Sales
      if (!db.objectStoreNames.contains(SALES_STORE)) {
        const s = db.createObjectStore(SALES_STORE, { keyPath: "id" });
        s.createIndex("inventoryId", "inventoryId", { unique: true });
        s.createIndex("soldDate", "soldDate");
        s.createIndex("soldOn", "soldOn");
        s.createIndex("city", "city");
      }

      // Expenses
      if (!db.objectStoreNames.contains(EXPENSES_STORE)) {
        const s = db.createObjectStore(EXPENSES_STORE, { keyPath: "id" });
        s.createIndex("date", "date");
        s.createIndex("category", "category");
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

async function saleByInventoryId(inventoryId) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(SALES_STORE, "readonly");
    const store = tx.objectStore(SALES_STORE);
    let index;
    try {
      index = store.index("inventoryId");
    } catch {
      resolve(null);
      db.close();
      return;
    }
    const req = index.get(inventoryId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
    tx.oncomplete = () => db.close();
  });
}

/** =======================
 *  State
 *  ======================= */
let allInv = [];
let allSales = [];
let allExpenses = [];

let charts = {
  profitLine: null,
  revProfitCombo: null,
  marketBar: null,
  marketRevenueBar: null,
  cityBar: null,
  conditionBar: null,
  sellThroughCond: null,
  batchBar: null,
};

/** =======================
 *  Tabs
 *  ======================= */
function showView(id) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll(".tabBtn").forEach((b) => b.classList.remove("active"));
  $(`#${id}`)?.classList.add("active");
  document.querySelector(`.tabBtn[data-view="${id}"]`)?.classList.add("active");
  // small QoL
  window.scrollTo({ top: 0, behavior: "instant" });
}

/** =======================
 *  Inventory (domain)
 *  ======================= */
function invTotalCost(inv) {
  return toNum(inv.purchaseCost) + toNum(inv.materialCost);
}

// Revenue should be item-only (shipping charged is not "revenue" KPI)
function saleItemRevenue(s) {
  return toNum(s.itemPrice);
}
function saleShippingRevenue(s) {
  return toNum(s.shippingCharged);
}

// direct: purchase + per-set material + shipping paid + platform fees
function saleDirectCosts(inv, s) {
  return invTotalCost(inv) + toNum(s.shippingPaid) + toNum(s.platformFees);
}


/** =======================
 *  Filters (Inventory list)
 *  ======================= */
function getFilteredInventory() {
  const q = ($("#searchInput")?.value || "").trim().toLowerCase();
  const status = $("#statusFilter")?.value || "all";
  const condFilter = $("#conditionFilter")?.value || "all";
  const batchFilter = $("#batchFilter")?.value || "all";

  return allInv.filter((inv) => {
    if (status !== "all" && (inv.status || "in_stock") !== status) return false;

    const c = normalizeCondition(inv.condition);
    if (condFilter !== "all" && c !== condFilter) return false;

    const b = normalizeBatch(inv.batch);
    if (batchFilter !== "all" && b !== batchFilter) return false;

    if (!q) return true;

    const hay = [
      inv.name,
      inv.setNumber,
      inv.batch,
      inv.boughtFrom,
      inv.buyPayment,
      inv.status,
      CONDITION_LABELS[c],
    ]
      .join(" ")
      .toLowerCase();

    return hay.includes(q);
  });
}

/** =======================
 *  UI helpers
 *  ======================= */
function setPreview(imgEl, url) {
  if (!imgEl) return;
  const u = (url || "").trim();
  if (!u) {
    imgEl.removeAttribute("src");
    imgEl.style.display = "none";
  } else {
    imgEl.src = u;
    imgEl.style.display = "block";
  }
}

/** =======================
 *  Inventory UI (Add/Edit)
 *  ======================= */
function normalizeInvFormData(fd) {
  const o = Object.fromEntries(fd.entries());
  return {
    id: o.id || uid(),
    name: (o.name || "").trim(),
    setNumber: (o.setNumber || "").trim(),
    setImageUrl: (o.setImageUrl || "").trim(),
    purchaseDate: o.purchaseDate || "",
    batch: normalizeBatch(o.batch),
    condition: normalizeCondition(o.condition),
    boughtFrom: (o.boughtFrom || "").trim(),
    buyPayment: (o.buyPayment || "").trim(),
    purchaseCost: toNum(o.purchaseCost),
    materialCost: toNum(o.materialCost),
    boxIncluded: (o.boxIncluded || "yes"),
    manualIncluded: (o.manualIncluded || "yes"),
    status: (o.status || "in_stock"), // internal only
    createdAt: o.createdAt ? toNum(o.createdAt) : Date.now(),
    updatedAt: Date.now(),
  };
}

function setInvForm(inv) {
  const f = $("#invForm");
  if (!f) return;
  f.id.value = inv?.id || "";
  f.name.value = inv?.name || "";
  f.setNumber.value = inv?.setNumber || "";
  f.setImageUrl.value = inv?.setImageUrl || "";
  f.purchaseDate.value = inv?.purchaseDate || "";
  f.batch.value = inv?.batch || "";
  f.condition.value = normalizeCondition(inv?.condition || "used_incomplete");
  f.boughtFrom.value = inv?.boughtFrom || "";
  f.buyPayment.value = inv?.buyPayment || "";
  f.purchaseCost.value = inv?.purchaseCost ?? "";
  f.materialCost.value = inv?.materialCost ?? 0;
  f.boxIncluded.value = inv?.boxIncluded || "yes";
  f.manualIncluded.value = inv?.manualIncluded || "yes";

  setPreview($("#invPhotoPreview"), inv?.setImageUrl || "");
  $("#invSaveBtn").textContent = inv?.id ? "Update Inventory" : "Save Inventory";
}

function resetInvForm() {
  setInvForm(null);
  $("#invSaveBtn").textContent = "Save Inventory";
}

/** =======================
 *  Sales UI
 *  ======================= */
function normalizeSaleFormData(fd) {
  const o = Object.fromEntries(fd.entries());
  return {
    id: o.saleId || uid(),
    inventoryId: o.inventoryId || "",
    soldDate: o.soldDate || "",
    soldOn: (o.soldOn || "").trim(),
    city: (o.city || "").trim(),
    buyer: (o.buyer || "").trim(),
    itemPrice: toNum(o.itemPrice),
    shippingCharged: toNum(o.shippingCharged),
    shippingPaid: toNum(o.shippingPaid),
    platformFees: toNum(o.platformFees),
    sellPayment: (o.sellPayment || "").trim(),
    notes: (o.notes || "").trim(),
    createdAt: o.createdAt ? toNum(o.createdAt) : Date.now(),
    updatedAt: Date.now(),
  };
}

function setSaleForm(inv, sale) {
  const f = $("#saleForm");
  if (!f) return;

  f.inventoryId.value = inv?.id || "";
  f.saleId.value = sale?.id || "";

  f.soldDate.value = sale?.soldDate || "";
  f.soldOn.value = sale?.soldOn || "";
  f.city.value = sale?.city || "";
  f.buyer.value = sale?.buyer || "";

  f.itemPrice.value = sale?.itemPrice ?? "";
  f.shippingCharged.value = sale?.shippingCharged ?? 0;
  f.shippingPaid.value = sale?.shippingPaid ?? 0;
  f.platformFees.value = sale?.platformFees ?? 0;

  f.sellPayment.value = sale?.sellPayment || "";
  f.notes.value = sale?.notes || "";

  $("#saleSaveBtn").textContent = sale?.id ? "Update Sale" : "Save Sale";
  setPreview($("#salePhotoPreview"), inv?.setImageUrl || "");
}

function resetSaleForm() {
  const f = $("#saleForm");
  if (!f) return;
  f.reset();
  f.inventoryId.value = "";
  f.saleId.value = "";
  $("#saleSaveBtn").textContent = "Save Sale";
  setPreview($("#salePhotoPreview"), "");
}

/** =======================
 *  Trade UI
 *  ======================= */
const tradeSelected = new Set();

function tradeSelectedCost() {
  let sum = 0;
  for (const id of tradeSelected) {
    const inv = allInv.find((x) => x.id === id);
    if (inv) sum += invTotalCost(inv);
  }
  return sum;
}

function updateTradeBadge() {
  const b = $("#tradeTotalBadge");
  if (b) b.textContent = `Selected Cost: ${money(tradeSelectedCost())}`;
}

function renderTradePickTable() {
  const tb = $("#tradePickTbody");
  if (!tb) return;
  tb.innerHTML = "";

  const inStock = allInv.filter((i) => (i.status || "in_stock") === "in_stock");
  const sorted = [...inStock].sort((a, b) => (b.purchaseDate || "").localeCompare(a.purchaseDate || ""));

  for (const inv of sorted) {
    const checked = tradeSelected.has(inv.id);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">
        <input type="checkbox" data-trade-pick="${escapeHtml(inv.id)}" ${checked ? "checked" : ""} />
      </td>
      <td>
        <div style="display:flex;gap:10px;align-items:center;">
          ${renderThumb(inv.setImageUrl)}
          <div style="display:flex;flex-direction:column;gap:4px;">
            <div style="font-weight:900;">${escapeHtml(inv.name || "(unnamed)")}${inv.setNumber ? ` • #${escapeHtml(inv.setNumber)}` : ""}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
              ${conditionBadge(inv.condition)}
              ${inv.boxIncluded === "yes" ? `<span class="badge">📦 Box</span>` : `<span class="badge">📭 No Box</span>`}
              ${inv.manualIncluded === "yes" ? `<span class="badge">📘 Manual</span>` : `<span class="badge">📄 No Manual</span>`}
            </div>
          </div>
        </div>
      </td>
      <td>${batchBadge(inv.batch)}</td>
      <td class="mono">${money(invTotalCost(inv))}</td>
    `;
    tb.appendChild(tr);
  }

  updateTradeBadge();
}

function setTradeFormDefaults() {
  const f = $("#tradeForm");
  if (!f) return;
  f.reset();
  f.setImageUrl.value = "";
  setPreview($("#tradePhotoPreview"), "");
  $("#tradeBtn").textContent = "Complete Trade";
}

/** =======================
 *  Expenses UI
 *  ======================= */
function normalizeExpenseForm(fd) {
  const o = Object.fromEntries(fd.entries());
  return {
    id: uid(),
    amount: toNum(o.amount),
    category: (o.category || "").trim(),
    date: o.date || "",
    note: (o.note || "").trim(),
    createdAt: Date.now(),
  };
}

function renderExpensesTable(list) {
  const tb = $("#expenseTbody");
  if (!tb) return;
  tb.innerHTML = "";

  const sorted = [...list].sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  for (const e of sorted) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${escapeHtml(e.date || "—")}</td>
      <td>${escapeHtml(e.category || "")}</td>
      <td>${escapeHtml(e.note || "")}</td>
      <td class="mono">${money(toNum(e.amount))}</td>
      <td>
        <div class="rowActions">
          <button class="iconBtn" data-exp-del="${escapeHtml(e.id)}" title="Delete">🗑️</button>
        </div>
      </td>
    `;
    tb.appendChild(tr);
  }
}

function renderExpenseSummary(list) {
  const el = $("#expenseSummary");
  if (!el) return;

  const totals = new Map();
  for (const e of list) {
    const cat = (e.category || "Other").trim() || "Other";
    totals.set(cat, (totals.get(cat) || 0) + toNum(e.amount));
  }

  const rows = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `<span class="badge">${escapeHtml(cat)}: <span class="mono">${money(amt)}</span></span>`)
    .join(" ");

  el.innerHTML = rows || `<span class="small">No expenses yet.</span>`;
}

/** =======================
 *  Inventory list rendering
 *  ======================= */
function computeInvSaleSnapshot(inv) {
  const sale = allSales.find((s) => s.inventoryId === inv.id) || null;
  const sold = (inv.status || "in_stock") === "sold" && sale;
  const revenue = sold ? saleItemRevenue(sale) : 0; // keep Revenue column = item only
  
  // Profit should include shipping charged (since shipping paid + fees are already costs)
  const grossTake = sold ? (saleItemRevenue(sale) + saleShippingRevenue(sale)) : 0;
  const directProfit = sold ? grossTake - saleDirectCosts(inv, sale) : 0;


  return { sale, sold, revenue, directProfit };
}

function renderInventoryTable(list) {
  const tb = $("#invTbody");
  if (!tb) return;
  tb.innerHTML = "";

  const sorted = [...list].sort((a, b) => (b.purchaseDate || "").localeCompare(a.purchaseDate || ""));

  for (const inv of sorted) {
    const { sale, sold, revenue, directProfit } = computeInvSaleSnapshot(inv);

    const status = inv.status || "in_stock";
    const statusBadge =
      status === "sold"
        ? `<span class="badge sold">✅ Sold</span>`
        : status === "exchanged"
        ? `<span class="badge">🔁 Exchanged</span>`
        : `<span class="badge unsold">🕒 In Stock</span>`;

    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>
        <div style="display:flex;gap:10px;align-items:center;">
          ${renderThumb(inv.setImageUrl)}
          <div style="display:flex;flex-direction:column;gap:4px;">
            <div style="font-weight:900;">${escapeHtml(inv.name || "(unnamed)")}${inv.setNumber ? ` • #${escapeHtml(inv.setNumber)}` : ""}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
              ${statusBadge}
              ${conditionBadge(inv.condition)}
              ${normalizeBatch(inv.batch) ? batchBadge(inv.batch) : ""}
              ${inv.boxIncluded === "yes" ? `<span class="badge">📦 Box</span>` : `<span class="badge">📭 No Box</span>`}
              ${inv.manualIncluded === "yes" ? `<span class="badge">📘 Manual</span>` : `<span class="badge">📄 No Manual</span>`}
              ${inv.boughtFrom ? `<span class="badge">🛒 ${escapeHtml(inv.boughtFrom)}</span>` : ""}
              ${inv.buyPayment ? `<span class="badge">💳 ${escapeHtml(inv.buyPayment)}</span>` : ""}
              ${sale?.buyer ? `<span class="badge">👤 ${escapeHtml(sale.buyer)}</span>` : ""}
            </div>
            ${
              sale?.notes
                ? `<div class="small">${escapeHtml(sale.notes)}</div>`
                : ""
            }
          </div>
        </div>
      </td>

      <td class="mono">
        <div>${escapeHtml(inv.purchaseDate || "—")}</div>
        <div class="small">Cost: ${money(invTotalCost(inv))}</div>
      </td>

      <td class="mono">${escapeHtml(sale?.soldDate || "—")}</td>
      <td class="mono">${sold ? money(revenue) : "—"}</td>
      <td class="mono" style="font-weight:900;color:${sold ? (directProfit >= 0 ? "rgba(34,197,94,0.95)" : "rgba(239,68,68,0.95)") : "inherit"};">
        ${sold ? money(directProfit) : "—"}
      </td>

      <td>${escapeHtml(sale?.soldOn || "—")}</td>
      <td>${escapeHtml(sale?.city || "—")}</td>
      <td>${conditionBadge(inv.condition)}</td>
      <td>${batchBadge(inv.batch)}</td>

      <td>
        <div class="rowActions">
          <button class="iconBtn" data-inv-edit="${escapeHtml(inv.id)}" title="Edit Inventory">✏️</button>
          <button class="iconBtn" data-inv-sell="${escapeHtml(inv.id)}" title="Sell / Edit Sale">🧾</button>
          <button class="iconBtn" data-inv-del="${escapeHtml(inv.id)}" title="Delete">🗑️</button>
        </div>
      </td>
    `;

    tb.appendChild(tr);
  }
}

/** =======================
 *  Batch UI updates
 *  ======================= */
function updateBatchUI() {
  const batches = [...new Set(allInv.map((x) => normalizeBatch(x.batch)).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );

  const dl = $("#batchList");
  if (dl) dl.innerHTML = batches.map((b) => `<option value="${escapeHtml(b)}"></option>`).join("");

  const bf = $("#batchFilter");
  if (bf) {
    const current = bf.value || "all";
    bf.innerHTML = `<option value="all">All Batches</option>` + batches.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join("");
    bf.value = [...bf.options].some((o) => o.value === current) ? current : "all";
  }

  const sbf = $("#statsBatchFilter");
  if (sbf) {
    const current = sbf.value || "all";
    sbf.innerHTML = `<option value="all">All Batches</option>` + batches.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join("");
    sbf.value = [...sbf.options].some((o) => o.value === current) ? current : "all";
  }
}

/** =======================
 *  Sell picker (unsold only)
 *  ======================= */
function updateUnsoldPicker() {
  const dl = $("#inventoryList");
  if (!dl) return;

  const unsold = allInv.filter((x) => (x.status || "in_stock") === "in_stock");
  const options = unsold
    .slice()
    .sort((a, b) => (b.purchaseDate || "").localeCompare(a.purchaseDate || ""))
    .map((inv) => {
      const label = `${inv.name || "(unnamed)"}${inv.setNumber ? ` • #${inv.setNumber}` : ""} • ${inv.id}`;
      return `<option value="${escapeHtml(label)}"></option>`;
    })
    .join("");

  dl.innerHTML = options;
}

function parsePickValueToId(v) {
  // value ends with " • <id>"
  const s = (v || "").trim();
  const parts = s.split(" • ");
  const last = parts[parts.length - 1];
  if (last && last.startsWith("id_")) return last;
  // crypto uuid
  if (last && /^[0-9a-f-]{16,}$/i.test(last)) return last;
  return "";
}

/** =======================
 *  Stats (allocation + charts)
 *  ======================= */
function statsRangeFilter(sales) {
  const range = $("#statsRange")?.value || "all";
  if (range === "all") return sales;

  const now = new Date();
  let start = null;

  if (range === "30d") {
    start = new Date(now);
    start.setDate(start.getDate() - 30);
  } else if (range === "90d") {
    start = new Date(now);
    start.setDate(start.getDate() - 90);
  } else if (range === "ytd") {
    start = new Date(now.getFullYear(), 0, 1);
  }

  if (!start) return sales;
  const startStr = start.toISOString().slice(0, 10);

  return sales.filter((s) => (s.soldDate || "") >= startStr);
}

function statsBatchFilterSales(sales) {
  const b = $("#statsBatchFilter")?.value || "all";
  if (b === "all") return sales;
  return sales.filter((s) => {
    const inv = allInv.find((x) => x.id === s.inventoryId);
    return normalizeBatch(inv?.batch) === b;
  });
}

function sumExpensesByType(expenses, salesInScope) {
  // Expense allocation over current filtered sales only (by revenue share)
  // Categories -> buckets
  // Supplies + Parts => material overhead
  // Shipping => shipping overhead
  // Gas + Fees(other) + Other => other overhead

  const totals = { material: 0, shipping: 0, other: 0 };

  for (const e of expenses) {
    const cat = (e.category || "").trim();
    const amt = toNum(e.amount);
    if (!amt) continue;

    if (cat === "Supplies" || cat === "Parts") totals.material += amt;
    else if (cat === "Shipping") totals.shipping += amt;
    else totals.other += amt;
  }

  // Allocation weights by revenue across salesInScope
  const revBySaleId = new Map();
  let totalRev = 0;
  for (const s of salesInScope) {
    const inv = allInv.find((x) => x.id === s.inventoryId);
    if (!inv || (inv.status || "in_stock") !== "sold") continue;
    const rev = saleItemRevenue(s);
    totalRev += rev;
    revBySaleId.set(s.id, rev);
  }

  return { totals, revBySaleId, totalRev: totalRev || 0.00001 };
}

function computeSaleNet(inv, sale, alloc) {
  const revenue = saleItemRevenue(sale) + saleShippingRevenue(sale);
  const direct = saleDirectCosts(inv, sale);

  const w = (alloc.revBySaleId.get(sale.id) || 0) / alloc.totalRev;
  const allocMaterial = alloc.totals.material * w;
  const allocShipping = alloc.totals.shipping * w;
  const allocOther = alloc.totals.other * w;

  const netProfit = revenue - direct - allocMaterial - allocShipping - allocOther;

  return {
    revenue,
    directCosts: direct,
    allocMaterial,
    allocShipping,
    allocOther,
    netProfit,
  };
}

function getStatsBatchScopedInventory() {
  const b = $("#statsBatchFilter")?.value || "all";

  // exclude exchanged everywhere (you already do that elsewhere)
  const base = allInv.filter((inv) => (inv.status || "in_stock") !== "exchanged");

  if (b === "all") return base;

  return base.filter((inv) => normalizeBatch(inv.batch) === b);
}

    
function renderStats() {
  // Only SOLD items count in sales stats
  const soldInvIds = new Set(
    allInv.filter((i) => (i.status || "in_stock") === "sold").map((i) => i.id)
  );

  let sales = allSales.filter((s) => soldInvIds.has(s.inventoryId));

  // Filters (range + batch)
  sales = statsRangeFilter(sales);
  sales = statsBatchFilterSales(sales);

  // Allocate expenses across sales in scope
  const alloc = sumExpensesByType(allExpenses, sales);

  // Totals
  let itemRevenue = 0;
  let shippingCharged = 0;

  let purchaseCost = 0;
  let materialTotal = 0;

  let shippingPaidDirect = 0;
  let platformFeesDirect = 0;

  let shippingOverheadAllocated = 0; // "Shipping" category expenses (allocated)
  let otherOverheadAllocated = 0;    // everything else (allocated)

  let netProfit = 0;

  let totalDays = 0;
  let daysCount = 0;

  for (const s of sales) {
    const inv = allInv.find((x) => x.id === s.inventoryId);
    if (!inv) continue;

    const net = computeSaleNet(inv, s, alloc);

    itemRevenue += saleItemRevenue(s);
    shippingCharged += saleShippingRevenue(s);

    purchaseCost += toNum(inv.purchaseCost);
    materialTotal += toNum(inv.materialCost) + net.allocMaterial;

    shippingPaidDirect += toNum(s.shippingPaid);
    platformFeesDirect += toNum(s.platformFees);

    shippingOverheadAllocated += net.allocShipping;
    otherOverheadAllocated += net.allocOther;

    netProfit += net.netProfit;

    const d = daysBetween(inv.purchaseDate, s.soldDate);
    if (d !== null) {
      totalDays += d;
      daysCount++;
    }
  }

  const grossTake = itemRevenue + shippingCharged; // what buyer paid you total
  const margin = grossTake > 0 ? (netProfit / grossTake) * 100 : 0;
  const avgProfit = sales.length ? netProfit / sales.length : 0;

  // Inventory KPIs should respect selected batch (NOT date range)
  const invScope = getStatsBatchScopedInventory();
  const unsoldInv = invScope.filter((i) => (i.status || "in_stock") === "in_stock");
  const soldInv = invScope.filter((i) => (i.status || "in_stock") === "sold");

  const investedUnsold = unsoldInv.reduce((sum, inv) => sum + invTotalCost(inv), 0);
  const sellThrough = (soldInv.length / Math.max(1, invScope.length)) * 100;
  const avgDays = daysCount ? Math.round(totalDays / daysCount) : 0;

  // Write KPIs safely (don’t crash if an element is missing)
  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setText("kpiRevenue", money(itemRevenue));
  setText("kpiShipCharged", money(shippingCharged));
  setText("kpiShipPaid", money(shippingPaidDirect));
  setText("kpiFees", money(platformFeesDirect));

  setText("kpiPurchase", money(purchaseCost));
  setText("kpiMaterial", money(materialTotal));

  // Other overhead = allocated overhead + allocated shipping overhead
  setText("kpiOther", money(otherOverheadAllocated + shippingOverheadAllocated));

  setText("kpiProfit", money(netProfit));
  setText("kpiMargin", pct(margin));
  setText("kpiAvgProfit", money(avgProfit));

  setText("kpiInvestedUnsold", money(investedUnsold));
  setText("kpiUnsoldCount", String(unsoldInv.length));
  setText("kpiSellThrough", pct(sellThrough));
  setText("kpiAvgDays", String(avgDays));

  renderCharts(sales, alloc);
}


function destroyChart(key) {
  if (charts[key]) {
    charts[key].destroy();
    charts[key] = null;
  }
}

function renderCharts(sales, alloc) {
  if (!window.Chart) return;

  // build net results per sale
  const rows = [];
  for (const s of sales) {
    const inv = allInv.find((x) => x.id === s.inventoryId);
    if (!inv) continue;
    rows.push({ inv, sale: s, net: computeSaleNet(inv, s, alloc) });
  }

  // Profit over time (month)
  const profitByMonth = new Map();
  const revByMonth = new Map();
  const feesShipByMonth = new Map();

  for (const r of rows) {
    const k = ym(r.sale.soldDate);
    if (!k) continue;
    profitByMonth.set(k, (profitByMonth.get(k) || 0) + r.net.netProfit);
    revByMonth.set(k, (revByMonth.get(k) || 0) + r.net.revenue);
    feesShipByMonth.set(k, (feesShipByMonth.get(k) || 0) + toNum(r.sale.shippingPaid) + toNum(r.sale.platformFees));
  }

  const months = [...profitByMonth.keys()].sort();
  const profitVals = months.map((m) => profitByMonth.get(m) || 0);
  const revVals = months.map((m) => revByMonth.get(m) || 0);
  const feesShipVals = months.map((m) => feesShipByMonth.get(m) || 0);

  // Profit by marketplace + revenue by marketplace
  const profitByMarket = new Map();
  const revByMarket = new Map();
  for (const r of rows) {
    const mk = (r.sale.soldOn || "Unknown").trim() || "Unknown";
    profitByMarket.set(mk, (profitByMarket.get(mk) || 0) + r.net.netProfit);
    revByMarket.set(mk, (revByMarket.get(mk) || 0) + r.net.revenue);
  }
  const marketTop = [...profitByMarket.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const marketLabels = marketTop.map(([k]) => k);
  const marketProfitVals = marketLabels.map((k) => profitByMarket.get(k) || 0);
  const marketRevVals = marketLabels.map((k) => revByMarket.get(k) || 0);

  // Profit by city
  const profitByCity = new Map();
  for (const r of rows) {
    const city = (r.sale.city || "Unknown").trim() || "Unknown";
    profitByCity.set(city, (profitByCity.get(city) || 0) + r.net.netProfit);
  }
  const cityTop = [...profitByCity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const cityLabels = cityTop.map(([k]) => k);
  const cityVals = cityLabels.map((k) => profitByCity.get(k) || 0);

  // Profit by condition
  const profitByCond = new Map();
  const soldByCond = new Map();
  for (const r of rows) {
    const c = normalizeCondition(r.inv.condition);
    profitByCond.set(c, (profitByCond.get(c) || 0) + r.net.netProfit);
    soldByCond.set(c, (soldByCond.get(c) || 0) + 1);
  }
  const condOrder = ["new_sealed", "new_openbox", "used_complete", "used_incomplete"];
  const condLabels = condOrder.map((k) => CONDITION_LABELS[k]);
  const condProfitVals = condOrder.map((k) => profitByCond.get(k) || 0);

  // Sell-through by condition
  const invCountByCond = new Map();
  for (const inv of allInv) {
    if ((inv.status || "in_stock") === "exchanged") continue;
    const c = normalizeCondition(inv.condition);
    invCountByCond.set(c, (invCountByCond.get(c) || 0) + 1);
  }
  const sellThroughVals = condOrder.map((k) => {
    const sold = soldByCond.get(k) || 0;
    const total = invCountByCond.get(k) || 0;
    return total ? (sold / total) * 100 : 0;
  });

  // Profit by batch and spent vs revenue by batch
  const profitByBatch = new Map();
  const spentByBatch = new Map();
  const revByBatch = new Map();
  for (const r of rows) {
    const b = normalizeBatch(r.inv.batch) || "No Batch";
    profitByBatch.set(b, (profitByBatch.get(b) || 0) + r.net.netProfit);
    spentByBatch.set(b, (spentByBatch.get(b) || 0) + invTotalCost(r.inv));
    revByBatch.set(b, (revByBatch.get(b) || 0) + r.net.revenue);
  }
  const batchTop = [...profitByBatch.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const batchLabels = batchTop.map(([k]) => k);
  const batchProfitVals = batchLabels.map((k) => profitByBatch.get(k) || 0);
  const batchSpentVals = batchLabels.map((k) => spentByBatch.get(k) || 0);
  const batchRevVals = batchLabels.map((k) => revByBatch.get(k) || 0);

  const common = { color: "#e5edff", grid: "rgba(255,255,255,0.08)" };

  // Profit line
  const profitLineEl = $("#profitLine");
  if (profitLineEl) {
    destroyChart("profitLine");
    charts.profitLine = new Chart(profitLineEl.getContext("2d"), {
      type: "line",
      data: {
        labels: months.length ? months : ["—"],
        datasets: [
          {
            label: "Net Profit",
            data: months.length ? profitVals : [0],
            borderColor: "rgba(34,197,94,0.95)",
            backgroundColor: "rgba(34,197,94,0.20)",
            fill: true,
            tension: 0.25,
            pointRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: common.color } },
          tooltip: { callbacks: { label: (ctx) => ` ${money(ctx.parsed.y)}` } },
        },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } },
        },
      },
    });
  }

  // Revenue vs Profit combo
  const comboEl = $("#revProfitCombo");
  if (comboEl) {
    destroyChart("revProfitCombo");
    charts.revProfitCombo = new Chart(comboEl.getContext("2d"), {
      data: {
        labels: months.length ? months : ["—"],
        datasets: [
          {
            type: "bar",
            label: "Revenue",
            data: months.length ? revVals : [0],
            backgroundColor: "rgba(59,130,246,0.35)",
            borderColor: "rgba(255,255,255,0.18)",
            borderWidth: 1,
            yAxisID: "y",
          },
          {
            type: "line",
            label: "Net Profit",
            data: months.length ? profitVals : [0],
            borderColor: "rgba(34,197,94,0.95)",
            backgroundColor: "rgba(34,197,94,0.20)",
            tension: 0.25,
            pointRadius: 3,
            yAxisID: "y",
          },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: common.color } } },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } },
        },
      },
    });
  }

  // Profit by marketplace
  const marketEl = $("#marketBar");
  if (marketEl) {
    destroyChart("marketBar");
    charts.marketBar = new Chart(marketEl.getContext("2d"), {
      type: "bar",
      data: {
        labels: marketLabels.length ? marketLabels : ["—"],
        datasets: [
          {
            label: "Net Profit",
            data: marketLabels.length ? marketProfitVals : [0],
            backgroundColor: (ctx) => ((ctx.raw ?? 0) >= 0 ? "rgba(34,197,94,0.55)" : "rgba(239,68,68,0.55)"),
            borderColor: "rgba(255,255,255,0.18)",
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: common.color } } },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } },
        },
      },
    });
  }

  // Revenue by marketplace
  const marketRevEl = $("#marketRevenueBar");
  if (marketRevEl) {
    destroyChart("marketRevenueBar");
    charts.marketRevenueBar = new Chart(marketRevEl.getContext("2d"), {
      type: "bar",
      data: {
        labels: marketLabels.length ? marketLabels : ["—"],
        datasets: [
          {
            label: "Revenue",
            data: marketLabels.length ? marketRevVals : [0],
            backgroundColor: "rgba(59,130,246,0.35)",
            borderColor: "rgba(255,255,255,0.18)",
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: common.color } } },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } },
        },
      },
    });
  }

  // Profit by city
  const cityEl = $("#cityBar");
  if (cityEl) {
    destroyChart("cityBar");
    charts.cityBar = new Chart(cityEl.getContext("2d"), {
      type: "bar",
      data: {
        labels: cityLabels.length ? cityLabels : ["—"],
        datasets: [
          {
            label: "Net Profit",
            data: cityLabels.length ? cityVals : [0],
            backgroundColor: (ctx) => ((ctx.raw ?? 0) >= 0 ? "rgba(168,85,247,0.45)" : "rgba(239,68,68,0.55)"),
            borderColor: "rgba(255,255,255,0.18)",
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: common.color } } },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } },
        },
      },
    });
  }

  // Profit by condition
  const condEl = $("#conditionBar");
  if (condEl) {
    destroyChart("conditionBar");
    charts.conditionBar = new Chart(condEl.getContext("2d"), {
      type: "bar",
      data: {
        labels: condLabels,
        datasets: [
          {
            label: "Net Profit",
            data: condProfitVals,
            backgroundColor: (ctx) => ((ctx.raw ?? 0) >= 0 ? "rgba(59,130,246,0.45)" : "rgba(239,68,68,0.55)"),
            borderColor: "rgba(255,255,255,0.18)",
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: common.color } } },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } },
        },
      },
    });
  }

  // Sell-through by condition
  const stEl = $("#sellThroughCond");
  if (stEl) {
    destroyChart("sellThroughCond");
    charts.sellThroughCond = new Chart(stEl.getContext("2d"), {
      type: "bar",
      data: {
        labels: condLabels,
        datasets: [
          {
            label: "Sell-through %",
            data: sellThroughVals,
            backgroundColor: "rgba(34,197,94,0.35)",
            borderColor: "rgba(255,255,255,0.18)",
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: common.color } } },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color }, grid: { color: common.grid }, suggestedMax: 100 },
        },
      },
    });
  }

  // Profit by batch
  const batchEl = $("#batchBar");
  if (batchEl) {
    destroyChart("batchBar");
    charts.batchBar = new Chart(batchEl.getContext("2d"), {
      type: "bar",
      data: {
        labels: batchLabels.length ? batchLabels : ["—"],
        datasets: [
          {
            label: "Net Profit",
            data: batchLabels.length ? batchProfitVals : [0],
            backgroundColor: (ctx) => ((ctx.raw ?? 0) >= 0 ? "rgba(168,85,247,0.45)" : "rgba(239,68,68,0.55)"),
            borderColor: "rgba(255,255,255,0.18)",
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: common.color } } },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } },
        },
      },
    });
  }
}

/** =======================
 *  CSV Import
 *  ======================= */
function parseCSV(text) {
  // Strip UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let i = 0;
  let field = "";
  let row = [];
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];

    if (c === '"') {
      // Escaped quote inside quotes: ""
      if (inQuotes && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      inQuotes = !inQuotes;
      i++;
      continue;
    }

    if (!inQuotes && (c === "," || c === "\n" || c === "\r")) {
      pushField();

      // NEW: treat BOTH \n and \r as row breaks
      if (c === "\n" || c === "\r") {
        pushRow();
      }

      i++;

      // swallow the second char in CRLF
      if (c === "\r" && text[i] === "\n") i++;
      continue;
    }

    field += c;
    i++;
  }

  pushField();
  pushRow();

  // Trim empty trailing rows
  return rows.filter((r) => r.some((x) => String(x).trim() !== ""));
}


function headerMap(headers) {
  const m = new Map();
  headers.forEach((h, idx) => {
    const key = String(h || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");
    if (key) m.set(key, idx);
  });
  return m;
}

function getCell(row, hm, key) {
  const idx = hm.get(key);
  if (idx === undefined) return "";
  return row[idx] ?? "";
}

function conditionFromText(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return "used_incomplete";
  if (s.includes("sealed")) return "new_sealed";
  if (s.includes("open")) return "new_openbox";
  if (s.includes("complete")) return "used_complete";
  if (s.includes("incomplete")) return "used_incomplete";
  return normalizeCondition(s);
}

async function importCSVFile(file) {
  const text = await file.text();
  const rows = parseCSV(text);
  if (rows.length < 2) {
    toast("CSV looks empty.");
    return;
  }

  const headers = rows[0];
  const hm = headerMap(headers);

  // Expected columns (flexible):
  // name, set_number, setnumber, purchase_date, purchase_cost, material_cost, batch, condition, bought_from, buy_payment, box_included, manual_included,
  // sold_date, sold_on, city, buyer, item_price, shipping_charged, shipping_paid, platform_fees, sell_payment, notes
  const createdInv = [];
  const createdSales = [];

  // optional lookup if missing name/photo
  const key = getRBKey();
  let lookupsLeft = key ? 30 : 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];

    const setNumber = String(getCell(row, hm, "set_number") || getCell(row, hm, "setnumber") || "").trim();
    let name = String(getCell(row, hm, "name") || "").trim();
    let setImageUrl = String(getCell(row, hm, "set_image_url") || getCell(row, hm, "image") || "").trim();

    if ((!name || !setImageUrl) && setNumber && lookupsLeft > 0) {
      const info = await rebrickableLookup(setNumber);
      if (info) {
        if (!name && info.name) name = info.name;
        if (!setImageUrl && info.img) setImageUrl = info.img;
      }
      lookupsLeft--;
    }

    const inv = {
      id: uid(),
      name,
      setNumber,
      setImageUrl,
      purchaseDate: String(getCell(row, hm, "purchase_date") || getCell(row, hm, "date_bought") || "").trim(),
      batch: normalizeBatch(getCell(row, hm, "batch")),
      condition: conditionFromText(getCell(row, hm, "condition")),
      boughtFrom: String(getCell(row, hm, "bought_from") || "").trim(),
      buyPayment: String(getCell(row, hm, "buy_payment") || "").trim(),
      purchaseCost: toNum(getCell(row, hm, "purchase_cost") || getCell(row, hm, "purchase") || ""),
      materialCost: toNum(getCell(row, hm, "material_cost") || getCell(row, hm, "material") || ""),
      boxIncluded: String(getCell(row, hm, "box_included") || "yes").trim().toLowerCase() === "no" ? "no" : "yes",
      manualIncluded: String(getCell(row, hm, "manual_included") || "yes").trim().toLowerCase() === "no" ? "no" : "yes",
      status: "in_stock",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (!inv.name || !inv.purchaseDate) continue;

    // Optional sale in same CSV row
    const soldDate = String(getCell(row, hm, "sold_date") || "").trim();
    const itemPrice = toNum(getCell(row, hm, "item_price") || getCell(row, hm, "sold_price") || "");
    const shippingCharged = toNum(getCell(row, hm, "shipping_charged") || "");
    const shippingPaid = toNum(getCell(row, hm, "shipping_paid") || "");
    const platformFees = toNum(getCell(row, hm, "platform_fees") || getCell(row, hm, "fees") || "");

    if (soldDate && (itemPrice > 0 || shippingCharged > 0)) {
      inv.status = "sold";

      const sale = {
        id: uid(),
        inventoryId: inv.id,
        soldDate,
        soldOn: String(getCell(row, hm, "sold_on") || getCell(row, hm, "marketplace") || "").trim(),
        city: String(getCell(row, hm, "city") || "").trim(),
        buyer: String(getCell(row, hm, "buyer") || "").trim(),
        itemPrice,
        shippingCharged,
        shippingPaid,
        platformFees,
        sellPayment: String(getCell(row, hm, "sell_payment") || "").trim(),
        notes: String(getCell(row, hm, "notes") || "").trim(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      createdSales.push(sale);
    }

    createdInv.push(inv);
  }

  // write to DB
  for (const inv of createdInv) await txPut(INVENTORY_STORE, inv);
  for (const s of createdSales) await txPut(SALES_STORE, s);

  toast(`CSV imported ✅ (${createdInv.length} inventory, ${createdSales.length} sales)`);

  await reloadAll();
  rerenderAll();
}

/** =======================
 *  Export/Import JSON
 *  ======================= */
async function exportJSON() {
  const payload = {
    exportedAt: new Date().toISOString(),
    inventory: allInv,
    sales: allSales,
    expenses: allExpenses,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `lego-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Exported 📦");
}

async function importJSON(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    toast("Invalid JSON.");
    return;
  }

  const inv = Array.isArray(parsed.inventory) ? parsed.inventory : [];
  const sales = Array.isArray(parsed.sales) ? parsed.sales : [];
  const expenses = Array.isArray(parsed.expenses) ? parsed.expenses : [];

  // merge by overwrite
  for (const i of inv) await txPut(INVENTORY_STORE, { ...i, id: i.id || uid(), updatedAt: Date.now() });
  for (const s of sales) await txPut(SALES_STORE, { ...s, id: s.id || uid(), updatedAt: Date.now() });
  for (const e of expenses) await txPut(EXPENSES_STORE, { ...e, id: e.id || uid() });

  toast("Imported ✅");
  await reloadAll();
  rerenderAll();
}

/** =======================
 *  Service worker
 *  ======================= */
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (e) {
    console.warn("SW registration failed:", e);
  }
}

/** =======================
 *  Reload + render
 *  ======================= */
async function reloadAll() {
  allInv = await txGetAll(INVENTORY_STORE);
  allSales = await txGetAll(SALES_STORE);
  allExpenses = await txGetAll(EXPENSES_STORE);

  // normalize
  for (const inv of allInv) {
    inv.status = inv.status || "in_stock";
    inv.condition = normalizeCondition(inv.condition);
    inv.batch = normalizeBatch(inv.batch);
    inv.purchaseCost = toNum(inv.purchaseCost);
    inv.materialCost = toNum(inv.materialCost);
    if (inv.boxIncluded !== "yes" && inv.boxIncluded !== "no") inv.boxIncluded = "yes";
    if (inv.manualIncluded !== "yes" && inv.manualIncluded !== "no") inv.manualIncluded = "yes";
  }
}

function rerenderAll() {
  updateBatchUI();
  updateUnsoldPicker();

  // Inventory list
  const invList = getFilteredInventory();
  renderInventoryTable(invList);

  // Trade picker list
  renderTradePickTable();

  // Expenses
  renderExpensesTable(allExpenses);
  renderExpenseSummary(allExpenses);

  // Stats
  renderStats();
}

/** =======================
 *  Event handlers
 *  ======================= */
async function handleInvSave(ev) {
  ev.preventDefault();
  const f = ev.target;
  const fd = new FormData(f);
  const inv = normalizeInvFormData(fd);

  if (!inv.name) return toast("Name required.");
  if (!inv.purchaseDate) return toast("Purchase date required.");

  // Preserve existing status/createdAt if updating
  if (inv.id) {
    const existing = allInv.find((x) => x.id === inv.id);
    if (existing) {
      inv.status = existing.status || "in_stock";
      inv.createdAt = existing.createdAt || inv.createdAt;
    }
  }

  await txPut(INVENTORY_STORE, inv);
  toast(inv.id ? "Inventory updated ✅" : "Inventory saved ✅");

  await reloadAll();
  resetInvForm();
  rerenderAll();
}

async function handleInvLookup() {
  const f = $("#invForm");
  if (!f) return;
  const setNum = f.setNumber.value;
  const res = await rebrickableLookup(setNum);
  if (!res) return toast("Lookup failed.");
  if (res.name) f.name.value = res.name;
  if (res.img) {
    f.setImageUrl.value = res.img;
    setPreview($("#invPhotoPreview"), res.img);
  }
  toast("Filled ✅");
}

async function handleTradeLookup() {
  const f = $("#tradeForm");
  if (!f) return;
  const setNum = f.setNumber.value;
  const res = await rebrickableLookup(setNum);
  if (!res) return toast("Lookup failed.");
  if (res.name) f.name.value = res.name;
  if (res.img) {
    f.setImageUrl.value = res.img;
    setPreview($("#tradePhotoPreview"), res.img);
  }
  toast("Filled ✅");
}

async function handleInvTableClick(ev) {
  const editId = ev.target?.getAttribute?.("data-inv-edit");
  const sellId = ev.target?.getAttribute?.("data-inv-sell");
  const delId = ev.target?.getAttribute?.("data-inv-del");

  if (editId) {
    const inv = allInv.find((x) => x.id === editId);
    if (!inv) return;
    setInvForm(inv);
    showView("viewInventory");
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  if (sellId) {
    const inv = allInv.find((x) => x.id === sellId);
    if (!inv) return;

    const sale = await saleByInventoryId(inv.id);

    // Open Sell tab and load form (even if already sold)
    showView("viewSell");
    setSaleForm(inv, sale);

    // also fill picker textbox for clarity (not required)
    const pick = $("#invPick");
    if (pick) pick.value = `${inv.name || "(unnamed)"}${inv.setNumber ? ` • #${inv.setNumber}` : ""} • ${inv.id}`;

    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  if (delId) {
    const inv = allInv.find((x) => x.id === delId);
    if (!inv) return;

    const ok = confirm(`Delete "${inv.name}"? (This deletes its sale too if exists)`);
    if (!ok) return;

    // delete sale if present
    const sale = allSales.find((s) => s.inventoryId === inv.id);
    if (sale) await txDelete(SALES_STORE, sale.id);

    await txDelete(INVENTORY_STORE, inv.id);
    toast("Deleted 🗑️");

    await reloadAll();
    rerenderAll();
  }
}

async function handleSellPickerChange() {
  const v = $("#invPick")?.value || "";
  const id = parsePickValueToId(v);
  if (!id) return;

  const inv = allInv.find((x) => x.id === id);
  if (!inv) return;

  if ((inv.status || "in_stock") !== "in_stock") {
    toast("Sell picker shows unsold only. Edit sold via 🧾 in Inventory list.");
    return;
  }

  const existingSale = await saleByInventoryId(inv.id);
  setSaleForm(inv, existingSale);
  toast("Loaded ✅");
}

async function handleSaleSave(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const sale = normalizeSaleFormData(fd);

  if (!sale.inventoryId) return toast("Pick an inventory item first.");
  if (!sale.soldDate) return toast("Sold date required.");
  if (sale.itemPrice <= 0 && sale.shippingCharged <= 0) return toast("Enter item price and/or shipping charged.");

  const inv = allInv.find((x) => x.id === sale.inventoryId);
  if (!inv) return toast("Inventory item missing.");

  // write sale
  await txPut(SALES_STORE, sale);

  // set inventory status sold
  inv.status = "sold";
  inv.updatedAt = Date.now();
  await txPut(INVENTORY_STORE, inv);

  toast(sale.id ? "Sale saved ✅" : "Sale saved ✅");

  await reloadAll();
  rerenderAll();
}

async function handleSaleReset() {
  resetSaleForm();
  $("#invPick").value = "";
}

async function handleExpenseAdd(ev) {
  ev.preventDefault();
  const exp = normalizeExpenseForm(new FormData(ev.target));
  if (!exp.amount || exp.amount <= 0) return toast("Amount required.");
  if (!exp.date) return toast("Date required.");
  if (!exp.category) return toast("Category required.");

  await txPut(EXPENSES_STORE, exp);
  toast("Expense added ✅");

  ev.target.reset();
  // restore date default
  const d = $("#expenseForm")?.querySelector('input[name="date"]');
  if (d) d.value = new Date().toISOString().slice(0, 10);

  await reloadAll();
  rerenderAll();
}

async function handleExpenseTableClick(ev) {
  const id = ev.target?.getAttribute?.("data-exp-del");
  if (!id) return;
  await txDelete(EXPENSES_STORE, id);
  toast("Expense deleted 🗑️");
  await reloadAll();
  rerenderAll();
}

async function handleExpensesClear() {
  const ok = confirm("Clear all expenses? This cannot be undone.");
  if (!ok) return;
  await txClear(EXPENSES_STORE);
  toast("Expenses cleared 🗑️");
  await reloadAll();
  rerenderAll();
}

async function handleTradePickClick(ev) {
  const id = ev.target?.getAttribute?.("data-trade-pick");
  if (!id) return;
  const checked = ev.target.checked;
  if (checked) tradeSelected.add(id);
  else tradeSelected.delete(id);
  updateTradeBadge();
}

async function handleTradeClear() {
  tradeSelected.clear();
  renderTradePickTable();
  setTradeFormDefaults();
  toast("Selection cleared");
}

async function handleTradeSubmit(ev) {
  ev.preventDefault();

  if (!tradeSelected.size) return toast("Select at least 1 item to trade.");

  const f = ev.target;
  const fd = new FormData(f);
  const o = Object.fromEntries(fd.entries());

  const name = (o.name || "").trim();
  const setNumber = (o.setNumber || "").trim();
  const tradeDate = (o.tradeDate || "").trim();
  const batch = normalizeBatch(o.batch);
  const condition = normalizeCondition(o.condition);
  const setImageUrl = (o.setImageUrl || "").trim();
  const notes = (o.notes || "").trim();

  if (!name) return toast("New item name required.");
  if (!tradeDate) return toast("Trade date required.");

  // cost transfer: sum purchaseCost/materialCost
  let purchaseCostSum = 0;
  let materialCostSum = 0;

  const selectedInvs = [];
  for (const id of tradeSelected) {
    const inv = allInv.find((x) => x.id === id);
    if (inv && (inv.status || "in_stock") === "in_stock") selectedInvs.push(inv);
  }
  if (!selectedInvs.length) return toast("Selected items are not in stock.");

  for (const inv of selectedInvs) {
    purchaseCostSum += toNum(inv.purchaseCost);
    materialCostSum += toNum(inv.materialCost);
  }

  // Create new inventory item (train)
  const newInvId = uid();
  const newInv = {
    id: newInvId,
    name,
    setNumber,
    setImageUrl,
    purchaseDate: tradeDate,
    batch,
    condition,
    boughtFrom: "Trade",
    buyPayment: "",
    purchaseCost: purchaseCostSum,
    materialCost: materialCostSum,
    boxIncluded: "yes",
    manualIncluded: "yes",
    status: "in_stock",
    tradeNotes: notes,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Mark old as exchanged (excluded from stats to avoid double counting)
  for (const inv of selectedInvs) {
    inv.status = "exchanged";
    inv.exchangedToId = newInvId;
    inv.exchangedAt = tradeDate;
    inv.updatedAt = Date.now();
    await txPut(INVENTORY_STORE, inv);

    // Safety: if a sale exists accidentally, delete it (to prevent double counting)
    const sale = allSales.find((s) => s.inventoryId === inv.id);
    if (sale) await txDelete(SALES_STORE, sale.id);
  }

  await txPut(INVENTORY_STORE, newInv);

  toast("Trade completed 🔁");
  tradeSelected.clear();
  setTradeFormDefaults();

  await reloadAll();
  rerenderAll();

  // Jump user to Inventory view to see new item
  showView("viewInventory");
}

/** =======================
 *  Install (PWA)
 *  ======================= */
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

/** =======================
 *  Init
 *  ======================= */
async function init() {
  // Tabs
  document.querySelectorAll(".tabBtn").forEach((btn) => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });

  // API Key
  $("#apiKeyBtn")?.addEventListener("click", () => {
    const current = getRBKey();
    const entered = prompt("Rebrickable API key (stored locally in your browser):", current);
    if (entered === null) return;
    setRBKey(entered);
    toast(getRBKey() ? "API key saved ✅" : "API key cleared");
  });

  // Inventory form defaults
  const todayStr = new Date().toISOString().slice(0, 10);
  const invForm = $("#invForm");
  if (invForm) invForm.purchaseDate.value = todayStr;
  setPreview($("#invPhotoPreview"), "");

  // Trade form defaults
  const tradeForm = $("#tradeForm");
  if (tradeForm) tradeForm.tradeDate.value = todayStr;
  setPreview($("#tradePhotoPreview"), "");

  // Sale form defaults
  const saleForm = $("#saleForm");
  if (saleForm) saleForm.soldDate.value = todayStr;
  setPreview($("#salePhotoPreview"), "");

  // Expense form defaults
  const expDate = $("#expenseForm")?.querySelector('input[name="date"]');
  if (expDate) expDate.value = todayStr;

  // Inventory actions
  $("#invLookupBtn")?.addEventListener("click", handleInvLookup);
  $("#invForm")?.addEventListener("submit", handleInvSave);
  $("#invResetBtn")?.addEventListener("click", resetInvForm);
  $("#invTbody")?.addEventListener("click", handleInvTableClick);

  // Filters
  $("#searchInput")?.addEventListener("input", rerenderAll);
  $("#statusFilter")?.addEventListener("change", rerenderAll);
  $("#conditionFilter")?.addEventListener("change", rerenderAll);
  $("#batchFilter")?.addEventListener("change", rerenderAll);

  // Sell
  $("#invPick")?.addEventListener("change", handleSellPickerChange);
  $("#saleForm")?.addEventListener("submit", handleSaleSave);
  $("#saleResetBtn")?.addEventListener("click", handleSaleReset);

  // Trade
  $("#tradePickTbody")?.addEventListener("click", handleTradePickClick);
  $("#tradeLookupBtn")?.addEventListener("click", handleTradeLookup);
  $("#tradeClearBtn")?.addEventListener("click", handleTradeClear);
  $("#tradeForm")?.addEventListener("submit", handleTradeSubmit);

  // Expenses
  $("#expenseForm")?.addEventListener("submit", handleExpenseAdd);
  $("#expenseTbody")?.addEventListener("click", handleExpenseTableClick);
  $("#clearExpensesBtn")?.addEventListener("click", handleExpensesClear);

  // Stats filters
  $("#statsRange")?.addEventListener("change", renderStats);
  $("#statsBatchFilter")?.addEventListener("change", renderStats);

  // Export / Import
  $("#exportBtn")?.addEventListener("click", exportJSON);
  $("#importInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await importJSON(file);
    e.target.value = "";
  });

  $("#importCsvInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await importCSVFile(file);
    e.target.value = "";
  });

  setupInstallFlow();
  await registerSW();

  await reloadAll();
  rerenderAll();

  // If Chart.js loads late, refresh charts once
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (window.Chart) {
      clearInterval(t);
      renderStats();
    }
    if (tries > 40) clearInterval(t);
  }, 100);
}

init();
