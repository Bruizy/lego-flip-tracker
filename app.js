/* app.js (FULL UPDATED)
   - Inventory + Sell + Expenses + Stats (deep)
   - Edit sold items (Sell tab loads existing sale for that item)
   - Notes + Sold Location + Buyer shown in Inventory list
   - Deeper stats + extra charts + filters
*/
"use strict";

/** ---------- Utilities ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const money = (n) => {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
};
const pct = (n) => `${(Number.isFinite(n) ? n : 0).toFixed(1)}%`;
const toNum = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  // Allow "$1,234.56" or "1,234.56"
  const s = String(v).trim().replace(/\$/g, "").replace(/,/g, "");
  const n = Number(s);
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
function parseDateMs(d) {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return NaN;
  const ms = Date.parse(`${d}T00:00:00`);
  return Number.isFinite(ms) ? ms : NaN;
}
function daysBetween(a, b) {
  const ams = parseDateMs(a);
  const bms = parseDateMs(b);
  if (!Number.isFinite(ams) || !Number.isFinite(bms)) return null;
  return Math.max(0, Math.round((bms - ams) / (1000 * 60 * 60 * 24)));
}

/** ---------- Tabs / Views ---------- */
const LAST_VIEW_KEY = "lft_last_view";
function setActiveView(viewId) {
  $$(".view").forEach(v => v.classList.toggle("active", v.id === viewId));
  $$(".tabBtn").forEach(b => b.classList.toggle("active", b.dataset.view === viewId));
  localStorage.setItem(LAST_VIEW_KEY, viewId);
}
function setupTabs() {
  $$(".tabBtn").forEach(btn => {
    btn.addEventListener("click", () => setActiveView(btn.dataset.view));
  });
  const last = localStorage.getItem(LAST_VIEW_KEY);
  if (last && $("#" + last)) setActiveView(last);
}

/** ---------- Rebrickable (name + photo) ---------- */
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

/** ---------- IndexedDB (Inventory + Sales + Expenses) ---------- */
const DB_NAME = "legoFlipDB";
const DB_VERSION = 4;

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
        s.createIndex("name", "name");
        s.createIndex("setNumber", "setNumber");
        s.createIndex("batch", "batch");
      }

      // Sales
      if (!db.objectStoreNames.contains(SALES_STORE)) {
        const s = db.createObjectStore(SALES_STORE, { keyPath: "id" });
        s.createIndex("inventoryId", "inventoryId", { unique: true }); // 1 sale per inventory item
        s.createIndex("soldDate", "soldDate");
        s.createIndex("soldOn", "soldOn");
        s.createIndex("buyer", "buyer");
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
async function txPut(storeName, obj) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const req = store.put(obj);
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
async function txGetSaleByInventoryId(inventoryId) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(SALES_STORE, "readonly");
    const store = tx.objectStore(SALES_STORE);
    const idx = store.index("inventoryId");
    const req = idx.get(inventoryId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
    tx.oncomplete = () => db.close();
  });
}

/** ---------- App State ---------- */
let inventory = [];
let sales = [];
let expenses = [];

function saleMap() {
  const m = new Map();
  for (const s of sales) m.set(s.inventoryId, s);
  return m;
}

/** ---------- Rendering helpers ---------- */
function renderItemThumb(url) {
  const u = (url || "").trim();
  if (!u) return "";
  const safe = escapeHtml(u);
  // Click opens image in new tab
  return `<a href="${safe}" target="_blank" rel="noopener">
    <img class="thumb clickable" src="${safe}" alt="set" loading="lazy" />
  </a>`;
}
function setPreview(imgEl, url) {
  if (!imgEl) return;
  const u = (url || "").trim();
  if (!u) {
    imgEl.removeAttribute("src");
    imgEl.style.display = "none";
    return;
  }
  imgEl.src = u;
  imgEl.style.display = "block";
}

/** ---------- Inventory form ---------- */
function normalizeInventoryForm(fd) {
  const o = Object.fromEntries(fd.entries());
  return {
    id: o.id || uid(),
    name: (o.name || "").trim(),
    setNumber: (o.setNumber || "").trim(),
    setImageUrl: (o.setImageUrl || "").trim(),
    purchaseDate: o.purchaseDate || "",
    purchaseCost: toNum(o.purchaseCost),
    materialCost: toNum(o.materialCost),
    condition: normalizeCondition(o.condition),
    batch: normalizeBatch(o.batch),
    boughtFrom: (o.boughtFrom || "").trim(),
    buyPayment: (o.buyPayment || "").trim(),
    boxIncluded: (o.boxIncluded || "yes"),
    manualIncluded: (o.manualIncluded || "yes"),
    createdAt: o.createdAt ? toNum(o.createdAt) : Date.now(),
    updatedAt: Date.now()
  };
}
function fillInventoryForm(item) {
  const f = $("#invForm");
  if (!f) return;

  f.id.value = item?.id || "";
  f.name.value = item?.name || "";
  f.setNumber.value = item?.setNumber || "";
  f.setImageUrl.value = item?.setImageUrl || "";
  f.purchaseDate.value = item?.purchaseDate || "";
  f.purchaseCost.value = item?.purchaseCost ?? "";
  f.materialCost.value = item?.materialCost ?? 0;
  f.condition.value = normalizeCondition(item?.condition || "used_incomplete");
  f.batch.value = item?.batch || "";
  f.boughtFrom.value = item?.boughtFrom || "";
  f.buyPayment.value = item?.buyPayment || "";
  f.boxIncluded.value = item?.boxIncluded || "yes";
  f.manualIncluded.value = item?.manualIncluded || "yes";

  setPreview($("#invPhotoPreview"), item?.setImageUrl || "");
  $("#invSaveBtn") && ($("#invSaveBtn").textContent = item ? "Update Inventory" : "Save Inventory");
}
function resetInventoryForm() { fillInventoryForm(null); }

async function saveInventory(ev) {
  ev.preventDefault();
  const item = normalizeInventoryForm(new FormData(ev.target));
  if (!item.name) return toast("Name required.");
  if (!item.purchaseDate) return toast("Purchase date required.");
  if (item.purchaseCost < 0) return toast("Purchase cost invalid.");

  // preserve createdAt if exists
  const existing = inventory.find(x => x.id === item.id);
  if (existing) item.createdAt = existing.createdAt || item.createdAt;

  await txPut(INVENTORY_STORE, item);
  toast(existing ? "Inventory updated ✅" : "Inventory saved ✅");

  inventory = await txGetAll(INVENTORY_STORE);
  rerenderAll();
  resetInventoryForm();
}

/** ---------- Sell form ---------- */
function normalizeSaleForm(fd) {
  const o = Object.fromEntries(fd.entries());
  return {
    id: o.saleId || uid(),
    inventoryId: (o.inventoryId || "").trim(),
    soldDate: o.soldDate || "",
    soldPrice: toNum(o.soldPrice),
    fees: toNum(o.fees),
    soldOn: (o.soldOn || "").trim(),
    sellPayment: (o.sellPayment || "").trim(),
    buyer: (o.buyer || "").trim(),
    notes: (o.notes || "").trim(),
    createdAt: o.createdAt ? toNum(o.createdAt) : Date.now(),
    updatedAt: Date.now()
  };
}
function resetSaleForm() {
  const f = $("#saleForm");
  if (!f) return;
  f.reset();
  f.inventoryId.value = "";
  f.saleId.value = "";
  $("#saleSaveBtn") && ($("#saleSaveBtn").textContent = "Save Sale");
  setPreview($("#salePhotoPreview"), "");
  // remove delete button if we added it
  const del = $("#saleDeleteBtn");
  if (del) del.remove();
}
function fillSaleForm(invItem, sale) {
  const f = $("#saleForm");
  if (!f) return;
  if (!invItem) return;

  // Set selection display (for convenience)
  const label = `${invItem.name || "(unnamed)"}${invItem.setNumber ? ` • #${invItem.setNumber}` : ""}`;
  $("#invPick") && ($("#invPick").value = label);

  f.inventoryId.value = invItem.id;

  if (sale) {
    f.saleId.value = sale.id;
    f.soldDate.value = sale.soldDate || "";
    f.soldPrice.value = sale.soldPrice ?? "";
    f.fees.value = sale.fees ?? 0;
    f.soldOn.value = sale.soldOn || "";
    f.sellPayment.value = sale.sellPayment || "";
    f.buyer.value = sale.buyer || "";
    f.notes.value = sale.notes || "";
    $("#saleSaveBtn") && ($("#saleSaveBtn").textContent = "Update Sale");
    ensureSaleDeleteButton();
  } else {
    f.saleId.value = "";
    f.soldDate.value = "";
    f.soldPrice.value = "";
    f.fees.value = 0;
    f.soldOn.value = "";
    f.sellPayment.value = "";
    f.buyer.value = "";
    f.notes.value = "";
    $("#saleSaveBtn") && ($("#saleSaveBtn").textContent = "Save Sale");
    const del = $("#saleDeleteBtn"); if (del) del.remove();
  }

  setPreview($("#salePhotoPreview"), invItem.setImageUrl || "");
}
function ensureSaleDeleteButton() {
  const row = $("#saleForm .row.buttons");
  if (!row) return;
  if ($("#saleDeleteBtn")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "saleDeleteBtn";
  btn.className = "btn";
  btn.textContent = "Delete Sale";
  btn.addEventListener("click", async () => {
    const f = $("#saleForm");
    const saleId = f?.saleId?.value;
    if (!saleId) return;
    const ok = confirm("Delete this sale? Item will return to In Stock.");
    if (!ok) return;
    await txDelete(SALES_STORE, saleId);
    sales = await txGetAll(SALES_STORE);
    toast("Sale deleted 🗑️");
    resetSaleForm();
    rerenderAll();
  });

  // Put it next to Clear by appending (you can reorder in CSS if wanted)
  row.appendChild(btn);
}

async function saveSale(ev) {
  ev.preventDefault();
  const f = ev.target;
  const sale = normalizeSaleForm(new FormData(f));

  if (!sale.inventoryId) return toast("Pick an inventory item.");
  if (!sale.soldDate) return toast("Sold date required.");
  if (sale.soldPrice <= 0) return toast("Sold price required.");

  // Enforce one sale per inventory item:
  const existing = sales.find(s => s.inventoryId === sale.inventoryId);
  if (existing && existing.id !== sale.id) {
    // If already exists, treat as edit (update same id)
    sale.id = existing.id;
    sale.createdAt = existing.createdAt || sale.createdAt;
  } else if (existing) {
    sale.createdAt = existing.createdAt || sale.createdAt;
  }

  await txPut(SALES_STORE, sale);
  toast(existing ? "Sale updated ✅" : "Sale saved ✅");

  sales = await txGetAll(SALES_STORE);
  rerenderAll();
  // keep selection, but reset fields lightly
  resetSaleForm();
}

/** ---------- Expenses ---------- */
function normalizeExpense(fd) {
  const o = Object.fromEntries(fd.entries());
  return {
    id: uid(),
    amount: toNum(o.amount),
    category: (o.category || "").trim(),
    date: o.date || "",
    note: (o.note || "").trim(),
    createdAt: Date.now()
  };
}
async function addExpense(ev) {
  ev.preventDefault();
  const exp = normalizeExpense(new FormData(ev.target));
  if (!exp.amount || exp.amount <= 0) return toast("Expense amount required.");
  if (!exp.date) return toast("Expense date required.");
  if (!exp.category) return toast("Category required.");

  await txPut(EXPENSES_STORE, exp);
  expenses = await txGetAll(EXPENSES_STORE);

  renderExpensesTable();
  renderExpenseSummary();
  rerenderStats(); // stats depend on expenses
  toast("Expense added ✅");
  ev.target.reset();

  // default date again
  const d = $("#expenseForm")?.querySelector('input[name="date"]');
  if (d) d.value = todayStr();
}
async function handleExpenseTableClick(ev) {
  const id = ev.target?.getAttribute?.("data-exp-del");
  if (!id) return;
  await txDelete(EXPENSES_STORE, id);
  expenses = await txGetAll(EXPENSES_STORE);
  renderExpensesTable();
  renderExpenseSummary();
  rerenderStats();
  toast("Expense deleted 🗑️");
}
async function clearExpenses() {
  const ok = confirm("Clear all expenses? This cannot be undone.");
  if (!ok) return;
  await txClear(EXPENSES_STORE);
  expenses = [];
  renderExpensesTable();
  renderExpenseSummary();
  rerenderStats();
  toast("Expenses cleared 🗑️");
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
      <td>
        <div class="rowActions">
          <button class="iconBtn" data-exp-del="${e.id}" title="Delete">🗑️</button>
        </div>
      </td>
    `;
    tb.appendChild(tr);
  }
}
function expenseCategoryTotals(expList) {
  const m = new Map();
  for (const e of expList) {
    const k = (e.category || "Other").trim() || "Other";
    m.set(k, (m.get(k) || 0) + toNum(e.amount));
  }
  return m;
}
function renderExpenseSummary() {
  const wrap = $("#expenseSummary");
  if (!wrap) return;

  const totals = expenseCategoryTotals(expenses);
  const keys = [...totals.keys()].sort((a, b) => a.localeCompare(b));

  if (!keys.length) {
    wrap.innerHTML = `<div class="small">No expenses yet.</div>`;
    return;
  }

  const chips = keys.map(k => `<span class="badge">${escapeHtml(k)}: <span class="mono">${money(totals.get(k) || 0)}</span></span>`).join(" ");
  wrap.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;">${chips}</div>`;
}

/** ---------- Inventory list (combined Inventory + Sale) ---------- */
function updateBatchFiltersFromInventory() {
  const batches = [...new Set(inventory.map(i => normalizeBatch(i.batch)).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const bf = $("#batchFilter");
  if (bf) {
    const cur = bf.value || "all";
    bf.innerHTML = [`<option value="all">All Batches</option>`, ...batches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`)].join("");
    if ([...bf.options].some(o => o.value === cur)) bf.value = cur;
  }

  const sbf = $("#statsBatchFilter");
  if (sbf) {
    const cur = sbf.value || "all";
    sbf.innerHTML = [`<option value="all">All Batches</option>`, ...batches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`)].join("");
    if ([...sbf.options].some(o => o.value === cur)) sbf.value = cur;
  }
}

function getInventoryListFiltered() {
  const q = ($("#searchInput")?.value || "").trim().toLowerCase();
  const status = $("#statusFilter")?.value || "all";
  const condFilter = $("#conditionFilter")?.value || "all";
  const batchFilter = $("#batchFilter")?.value || "all";

  const sm = saleMap();

  return inventory.filter(inv => {
    const sale = sm.get(inv.id);
    const isSold = !!sale && !!sale.soldDate && toNum(sale.soldPrice) > 0;

    if (status === "sold" && !isSold) return false;
    if (status === "in_stock" && isSold) return false;

    const c = normalizeCondition(inv.condition);
    if (condFilter !== "all" && c !== condFilter) return false;

    const b = normalizeBatch(inv.batch);
    if (batchFilter !== "all" && b !== batchFilter) return false;

    if (!q) return true;

    const hay = [
      inv.name, inv.setNumber, inv.batch, inv.boughtFrom, inv.buyPayment,
      sale?.soldOn, sale?.sellPayment, sale?.buyer, sale?.notes,
      CONDITION_LABELS[c]
    ].join(" ").toLowerCase();

    return hay.includes(q);
  });
}

function profitForSale(inv, sale) {
  const revenue = toNum(sale?.soldPrice);
  const purchase = toNum(inv?.purchaseCost);
  const material = toNum(inv?.materialCost);
  const shippingOut = toNum(sale?.fees); // fees field = fees + shipping out
  const grossProfit = revenue - (purchase + material + shippingOut);
  return { revenue, purchase, material, shippingOut, grossProfit };
}

function renderInventoryTable() {
  const tb = $("#invTbody");
  if (!tb) return;

  const sm = saleMap();
  const list = getInventoryListFiltered();

  // Sort newest first by purchaseDate then updatedAt
  const sorted = [...list].sort((a, b) => {
    const ad = a.purchaseDate || "0000-00-00";
    const bd = b.purchaseDate || "0000-00-00";
    if (ad !== bd) return bd.localeCompare(ad);
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  tb.innerHTML = "";
  for (const inv of sorted) {
    const sale = sm.get(inv.id) || null;
    const isSold = !!sale && !!sale.soldDate && toNum(sale.soldPrice) > 0;

    const { revenue, grossProfit } = profitForSale(inv, sale);
    const title = `${inv.name || "(unnamed)"}${inv.setNumber ? ` • #${inv.setNumber}` : ""}`;
    const statusBadge = isSold
      ? `<span class="badge sold">✅ Sold</span>`
      : `<span class="badge unsold">🕒 In Stock</span>`;

    const cond = conditionBadge(inv.condition);
    const batch = batchBadge(inv.batch);

    const soldDate = sale?.soldDate || "—";
    const soldOn = sale?.soldOn || "—";
    const buyer = sale?.buyer || "—";
    const notes = sale?.notes || "";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div style="display:flex;gap:10px;align-items:flex-start;">
          ${renderItemThumb(inv.setImageUrl)}
          <div style="display:flex;flex-direction:column;gap:6px;">
            <div style="font-weight:900;">${escapeHtml(title)}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
              ${statusBadge}
              ${cond}
              ${inv.boxIncluded === "yes" ? `<span class="badge">📦 Box</span>` : `<span class="badge">📭 No Box</span>`}
              ${inv.manualIncluded === "yes" ? `<span class="badge">📘 Manual</span>` : `<span class="badge">📄 No Manual</span>`}
              ${normalizeBatch(inv.batch) ? batch : ""}
              ${inv.boughtFrom ? `<span class="badge">🛒 ${escapeHtml(inv.boughtFrom)}</span>` : ""}
              ${inv.buyPayment ? `<span class="badge">💳 ${escapeHtml(inv.buyPayment)}</span>` : ""}
              ${isSold && soldOn !== "—" ? `<span class="badge">🏷️ ${escapeHtml(soldOn)}</span>` : ""}
              ${isSold && buyer !== "—" ? `<span class="badge">👤 ${escapeHtml(buyer)}</span>` : ""}
            </div>
            ${isSold && notes ? `<div class="small">${escapeHtml(notes)}</div>` : ""}
          </div>
        </div>
      </td>

      <td class="mono">
        <div>${escapeHtml(inv.purchaseDate || "—")}</div>
        <div class="small">Buy: ${money(toNum(inv.purchaseCost))}</div>
      </td>

      <td class="mono">
        <div>${escapeHtml(soldDate)}</div>
        <div class="small">${isSold ? `Fees: ${money(toNum(sale?.fees))}` : ""}</div>
      </td>

      <td class="mono">${isSold ? money(revenue) : "—"}</td>

      <td class="mono" style="font-weight:900;color:${grossProfit >= 0 ? "rgba(34,197,94,0.95)" : "rgba(239,68,68,0.95)"};">
        ${isSold ? money(grossProfit) : "—"}
      </td>

      <td>${escapeHtml(soldOn)}</td>
      <td>${escapeHtml(buyer)}</td>
      <td>${cond}</td>
      <td>${batch}</td>

      <td>
        <div class="rowActions">
          <button class="iconBtn" data-inv-edit="${inv.id}" title="Edit Inventory">✏️</button>
          <button class="iconBtn" data-inv-sell="${inv.id}" title="${isSold ? "Edit Sale" : "Sell"}">🧾</button>
          <button class="iconBtn" data-inv-del="${inv.id}" title="Delete Inventory (and sale)">🗑️</button>
        </div>
      </td>
    `;
    tb.appendChild(tr);
  }
}

async function handleInventoryTableClick(ev) {
  const editId = ev.target?.getAttribute?.("data-inv-edit");
  const sellId = ev.target?.getAttribute?.("data-inv-sell");
  const delId = ev.target?.getAttribute?.("data-inv-del");
  if (!editId && !sellId && !delId) return;

  if (editId) {
    const item = inventory.find(x => x.id === editId);
    if (!item) return;
    fillInventoryForm(item);
    setActiveView("viewInventory");
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  if (sellId) {
    const inv = inventory.find(x => x.id === sellId);
    if (!inv) return;
    const sale = await txGetSaleByInventoryId(inv.id);
    fillSaleForm(inv, sale);
    setActiveView("viewSell");
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  if (delId) {
    const inv = inventory.find(x => x.id === delId);
    if (!inv) return;
    const ok = confirm(`Delete "${inv.name}"? This also deletes its sale (if any).`);
    if (!ok) return;

    // delete sale (if exists) then inventory
    const existingSale = await txGetSaleByInventoryId(inv.id);
    if (existingSale) await txDelete(SALES_STORE, existingSale.id);
    await txDelete(INVENTORY_STORE, inv.id);

    inventory = await txGetAll(INVENTORY_STORE);
    sales = await txGetAll(SALES_STORE);
    toast("Deleted 🗑️");
    rerenderAll();
  }
}

/** ---------- Inventory datalist for Sell tab ---------- */
function renderInventoryDatalist() {
  const dl = $("#inventoryList");
  if (!dl) return;

  // show BOTH in-stock and sold, because user needs to edit sold items too
  // Use a display label that can be typed easily.
  const items = [...inventory].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  dl.innerHTML = items.map(inv => {
    const label = `${inv.name || "(unnamed)"}${inv.setNumber ? ` • #${inv.setNumber}` : ""}`;
    // store id in data attribute not supported by datalist option; we map later by label
    return `<option value="${escapeHtml(label)}"></option>`;
  }).join("");
}
function findInventoryByPickValue(v) {
  const val = (v || "").trim();
  if (!val) return null;

  // Try exact label match first
  const exact = inventory.find(inv => {
    const label = `${inv.name || "(unnamed)"}${inv.setNumber ? ` • #${inv.setNumber}` : ""}`;
    return label === val;
  });
  if (exact) return exact;

  // Fallback: if user typed set number
  const s = val.replace("#", "").trim();
  const bySet = inventory.find(inv => (inv.setNumber || "").trim() === s);
  if (bySet) return bySet;

  // Fallback: substring in name
  const low = val.toLowerCase();
  return inventory.find(inv => (inv.name || "").toLowerCase().includes(low)) || null;
}

/** ---------- Stats (Deep) ---------- */
let charts = {
  profitLine: null,
  revProfitCombo: null,
  marketBar: null,
  marketRevenueBar: null,
  conditionBar: null,
  sellThroughCond: null,
  batchBar: null,
  batchSpendRev: null,
  buyerBar: null,
  feesLine: null
};

function getStatsRangeFilter() {
  const v = $("#statsRange")?.value || "all";
  const now = new Date();
  const today = Date.parse(`${todayStr()}T00:00:00`);

  if (v === "30d") return { fromMs: today - 29 * 86400000, toMs: today + 86400000 };
  if (v === "90d") return { fromMs: today - 89 * 86400000, toMs: today + 86400000 };
  if (v === "ytd") {
    const y = now.getFullYear();
    const fromMs = Date.parse(`${y}-01-01T00:00:00`);
    return { fromMs, toMs: today + 86400000 };
  }
  return { fromMs: -Infinity, toMs: Infinity };
}
function inRange(dateStr, range) {
  const ms = parseDateMs(dateStr);
  if (!Number.isFinite(ms)) return false;
  return ms >= range.fromMs && ms < range.toMs;
}

function mapExpenseToBucket(category) {
  const c = (category || "").toLowerCase();
  if (c.includes("shipping")) return "shipping";
  if (c.includes("suppl") || c.includes("parts")) return "material";
  // gas / fees(other) / other => other
  return "other";
}

function allocateOverhead(overheadTotal, revenueByKeyMap) {
  const totalRev = [...revenueByKeyMap.values()].reduce((a, b) => a + b, 0);
  const alloc = new Map();
  for (const [k, rev] of revenueByKeyMap.entries()) {
    const share = totalRev > 0 ? (rev / totalRev) : 0;
    alloc.set(k, overheadTotal * share);
  }
  return alloc;
}

function rerenderStats() {
  if (!$("#viewStats")) return;
  if (!window.Chart) return;

  const sm = saleMap();
  const range = getStatsRangeFilter();
  const batchPick = $("#statsBatchFilter")?.value || "all";

  // Build sale records joined with inventory, filtered
  const soldRows = [];
  const unsoldRows = [];

  for (const inv of inventory) {
    if (batchPick !== "all" && normalizeBatch(inv.batch) !== batchPick) continue;
    const sale = sm.get(inv.id);
    if (sale && sale.soldDate && toNum(sale.soldPrice) > 0) {
      // stats date filter uses soldDate
      if (!inRange(sale.soldDate, range)) continue;
      soldRows.push({ inv, sale });
    } else {
      unsoldRows.push(inv);
    }
  }

  // Expenses in range (use expense date)
  const expInRange = expenses.filter(e => inRange(e.date, range));

  // Totals (sold-only for revenue/cogs/material/shippingOut)
  let revenue = 0;
  let purchase = 0;
  let material = 0;
  let shippingOut = 0;
  let grossProfit = 0;

  // For average days
  let totalDays = 0;
  let daysCount = 0;

  // Groupings
  const profitByMonthGross = new Map();
  const revenueByMonth = new Map();
  const feesByMonth = new Map();

  const profitByMarketGross = new Map();
  const revenueByMarket = new Map();

  const profitByCondGross = new Map();
  const soldCountByCond = new Map();
  const totalCountByCond = new Map();

  const profitByBatchGross = new Map();
  const revenueByBatch = new Map();
  const spendByBatch = new Map();

  const revenueByBuyer = new Map();
  const profitByBuyerGross = new Map();

  // Total count by condition (includes unsold filtered by batch)
  for (const inv of [...soldRows.map(r => r.inv), ...unsoldRows]) {
    const c = normalizeCondition(inv.condition);
    totalCountByCond.set(c, (totalCountByCond.get(c) || 0) + 1);
  }

  for (const { inv, sale } of soldRows) {
    const p = profitForSale(inv, sale);
    revenue += p.revenue;
    purchase += p.purchase;
    material += p.material;
    shippingOut += p.shippingOut;
    grossProfit += p.grossProfit;

    // days to sell
    const d = daysBetween(inv.purchaseDate, sale.soldDate);
    if (d !== null) { totalDays += d; daysCount++; }

    // month
    const m = ym(sale.soldDate);
    if (m) {
      profitByMonthGross.set(m, (profitByMonthGross.get(m) || 0) + p.grossProfit);
      revenueByMonth.set(m, (revenueByMonth.get(m) || 0) + p.revenue);
      feesByMonth.set(m, (feesByMonth.get(m) || 0) + p.shippingOut);
    }

    // market
    const market = (sale.soldOn || "").trim() || "Unknown";
    profitByMarketGross.set(market, (profitByMarketGross.get(market) || 0) + p.grossProfit);
    revenueByMarket.set(market, (revenueByMarket.get(market) || 0) + p.revenue);

    // condition
    const c = normalizeCondition(inv.condition);
    profitByCondGross.set(c, (profitByCondGross.get(c) || 0) + p.grossProfit);
    soldCountByCond.set(c, (soldCountByCond.get(c) || 0) + 1);

    // batch
    const b = normalizeBatch(inv.batch) || "No Batch";
    profitByBatchGross.set(b, (profitByBatchGross.get(b) || 0) + p.grossProfit);
    revenueByBatch.set(b, (revenueByBatch.get(b) || 0) + p.revenue);
    spendByBatch.set(b, (spendByBatch.get(b) || 0) + (p.purchase + p.material + p.shippingOut));

    // buyer
    const buyer = (sale.buyer || "").trim() || "Unknown";
    revenueByBuyer.set(buyer, (revenueByBuyer.get(buyer) || 0) + p.revenue);
    profitByBuyerGross.set(buyer, (profitByBuyerGross.get(buyer) || 0) + p.grossProfit);
  }

  // Overhead buckets from expenses in range
  let overheadMaterial = 0;
  let overheadShipping = 0;
  let overheadOther = 0;

  const overheadByMonth = new Map();
  const overheadShippingByMonth = new Map();

  for (const e of expInRange) {
    const amt = toNum(e.amount);
    const bucket = mapExpenseToBucket(e.category);
    if (bucket === "material") overheadMaterial += amt;
    else if (bucket === "shipping") overheadShipping += amt;
    else overheadOther += amt;

    const m = ym(e.date);
    if (m) {
      overheadByMonth.set(m, (overheadByMonth.get(m) || 0) + amt);
      if (bucket === "shipping") overheadShippingByMonth.set(m, (overheadShippingByMonth.get(m) || 0) + amt);
    }
  }

  const overheadTotal = overheadMaterial + overheadShipping + overheadOther;

  // Net profit totals
  const netProfit = grossProfit - overheadTotal;
  const netMargin = revenue > 0 ? (netProfit / revenue) * 100 : 0;
  const avgProfit = soldRows.length ? (netProfit / soldRows.length) : 0;

  // Invested unsold
  let investedUnsold = 0;
  for (const inv of unsoldRows) {
    investedUnsold += toNum(inv.purchaseCost) + toNum(inv.materialCost);
  }

  // sell-through
  const totalItems = soldRows.length + unsoldRows.length;
  const sellThrough = totalItems > 0 ? (soldRows.length / totalItems) * 100 : 0;

  // avg days
  const avgDays = daysCount ? (totalDays / daysCount) : 0;

  // KPIs
  $("#kpiRevenue") && ($("#kpiRevenue").textContent = money(revenue));
  $("#kpiPurchase") && ($("#kpiPurchase").textContent = money(purchase));
  $("#kpiMaterial") && ($("#kpiMaterial").textContent = money(material + overheadMaterial));
  $("#kpiShipping") && ($("#kpiShipping").textContent = money(shippingOut + overheadShipping));
  $("#kpiOther") && ($("#kpiOther").textContent = money(overheadOther));
  $("#kpiProfit") && ($("#kpiProfit").textContent = money(netProfit));
  $("#kpiMargin") && ($("#kpiMargin").textContent = pct(netMargin));
  $("#kpiAvgProfit") && ($("#kpiAvgProfit").textContent = money(avgProfit));

  $("#kpiInvestedUnsold") && ($("#kpiInvestedUnsold").textContent = money(investedUnsold));
  $("#kpiUnsoldCount") && ($("#kpiUnsoldCount").textContent = String(unsoldRows.length));
  $("#kpiSellThrough") && ($("#kpiSellThrough").textContent = pct(sellThrough));
  $("#kpiAvgDays") && ($("#kpiAvgDays").textContent = String(avgDays ? avgDays.toFixed(0) : 0));

  // Build month axis
  const months = [...new Set([...profitByMonthGross.keys(), ...overheadByMonth.keys(), ...revenueByMonth.keys()])].sort();
  const grossByMonth = months.map(m => profitByMonthGross.get(m) || 0);
  const overheadByMonthArr = months.map(m => overheadByMonth.get(m) || 0);
  const netByMonth = months.map((m, i) => (profitByMonthGross.get(m) || 0) - (overheadByMonthArr[i] || 0));
  const revByMonthArr = months.map(m => revenueByMonth.get(m) || 0);

  // Fees+shipping over time = sale fees + expense shipping
  const shippingExpByMonthArr = months.map(m => overheadShippingByMonth.get(m) || 0);
  const feesSaleByMonthArr = months.map(m => feesByMonth.get(m) || 0);
  const feesTotalByMonthArr = months.map((m, i) => (feesSaleByMonthArr[i] || 0) + (shippingExpByMonthArr[i] || 0));

  // Market alloc overhead by revenue share
  const marketOverheadAlloc = allocateOverhead(overheadTotal, revenueByMarket);
  const marketsTopProfit = [...profitByMarketGross.entries()]
    .map(([k, gp]) => [k, gp - (marketOverheadAlloc.get(k) || 0)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const marketProfitLabels = marketsTopProfit.map(([k]) => k);
  const marketProfitVals = marketsTopProfit.map(([, v]) => v);

  const marketsTopRevenue = [...revenueByMarket.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const marketRevLabels = marketsTopRevenue.map(([k]) => k);
  const marketRevVals = marketsTopRevenue.map(([, v]) => v);

  // Condition profit (net-allocated by revenue share within condition)
  const revenueByCond = new Map();
  for (const { inv, sale } of soldRows) {
    const c = normalizeCondition(inv.condition);
    revenueByCond.set(c, (revenueByCond.get(c) || 0) + toNum(sale.soldPrice));
  }
  const condOverheadAlloc = allocateOverhead(overheadTotal, revenueByCond);
  const condOrder = ["new_sealed", "new_openbox", "used_complete", "used_incomplete"];
  const condLabels = condOrder.map(k => CONDITION_LABELS[k]);
  const condProfitVals = condOrder.map(k => (profitByCondGross.get(k) || 0) - (condOverheadAlloc.get(k) || 0));

  // Sell-through by condition
  const condSellThrough = condOrder.map(k => {
    const soldC = soldCountByCond.get(k) || 0;
    const totalC = totalCountByCond.get(k) || 0;
    return totalC ? (soldC / totalC) * 100 : 0;
  });

  // Batch profit / spent vs revenue
  const batchOverheadAlloc = allocateOverhead(overheadTotal, revenueByBatch);
  const batchesTop = [...profitByBatchGross.entries()]
    .map(([k, gp]) => [k, gp - (batchOverheadAlloc.get(k) || 0)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const batchLabels = batchesTop.map(([k]) => k);
  const batchProfitVals = batchesTop.map(([, v]) => v);

  const batchSpendRevTop = [...revenueByBatch.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const batchSpendLabels = batchSpendRevTop.map(([k]) => k);
  const batchRevVals = batchSpendLabels.map(k => revenueByBatch.get(k) || 0);
  const batchSpendVals = batchSpendLabels.map(k => spendByBatch.get(k) || 0);

  // Buyer breakdown (top 10 by revenue)
  const buyerTop = [...revenueByBuyer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const buyerLabels = buyerTop.map(([k]) => k);
  const buyerVals = buyerTop.map(([, v]) => v);

  // Chart options
  const common = { color: "#e5edff", grid: "rgba(255,255,255,0.08)" };
  const destroy = (k) => { if (charts[k]) { charts[k].destroy(); charts[k] = null; } };

  // Net Profit Over Time
  const profitLineEl = $("#profitLine");
  if (profitLineEl) {
    destroy("profitLine");
    charts.profitLine = new Chart(profitLineEl.getContext("2d"), {
      type: "line",
      data: {
        labels: months.length ? months : ["—"],
        datasets: [{
          label: "Net Profit",
          data: months.length ? netByMonth : [0],
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

  // Revenue vs Profit Combo
  const comboEl = $("#revProfitCombo");
  if (comboEl) {
    destroy("revProfitCombo");
    charts.revProfitCombo = new Chart(comboEl.getContext("2d"), {
      type: "bar",
      data: {
        labels: months.length ? months : ["—"],
        datasets: [
          {
            type: "bar",
            label: "Revenue",
            data: months.length ? revByMonthArr : [0],
            backgroundColor: "rgba(59,130,246,0.35)",
            borderColor: "rgba(255,255,255,0.18)",
            borderWidth: 1
          },
          {
            type: "line",
            label: "Net Profit",
            data: months.length ? netByMonth : [0],
            borderColor: "rgba(34,197,94,0.95)",
            backgroundColor: "rgba(34,197,94,0.15)",
            tension: 0.25,
            pointRadius: 3,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: common.color } } },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } }
        }
      }
    });
  }

  // Profit by Marketplace
  const marketEl = $("#marketBar");
  if (marketEl) {
    destroy("marketBar");
    charts.marketBar = new Chart(marketEl.getContext("2d"), {
      type: "bar",
      data: {
        labels: marketProfitLabels.length ? marketProfitLabels : ["—"],
        datasets: [{
          label: "Profit (Net Alloc.)",
          data: marketProfitLabels.length ? marketProfitVals : [0],
          backgroundColor: (ctx) => (ctx.raw ?? 0) >= 0 ? "rgba(34,197,94,0.55)" : "rgba(239,68,68,0.55)",
          borderColor: "rgba(255,255,255,0.18)",
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: common.color } } },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } }
        }
      }
    });
  }

  // Revenue by Marketplace
  const marketRevEl = $("#marketRevenueBar");
  if (marketRevEl) {
    destroy("marketRevenueBar");
    charts.marketRevenueBar = new Chart(marketRevEl.getContext("2d"), {
      type: "bar",
      data: {
        labels: marketRevLabels.length ? marketRevLabels : ["—"],
        datasets: [{
          label: "Revenue",
          data: marketRevLabels.length ? marketRevVals : [0],
          backgroundColor: "rgba(59,130,246,0.40)",
          borderColor: "rgba(255,255,255,0.18)",
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: common.color } } },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } }
        }
      }
    });
  }

  // Profit by Condition
  const condEl = $("#conditionBar");
  if (condEl) {
    destroy("conditionBar");
    charts.conditionBar = new Chart(condEl.getContext("2d"), {
      type: "bar",
      data: {
        labels: condLabels,
        datasets: [{
          label: "Profit (Net Alloc.)",
          data: condProfitVals,
          backgroundColor: (ctx) => (ctx.raw ?? 0) >= 0 ? "rgba(59,130,246,0.45)" : "rgba(239,68,68,0.55)",
          borderColor: "rgba(255,255,255,0.18)",
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: common.color } } },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } }
        }
      }
    });
  }

  // Sell-through by Condition
  const stEl = $("#sellThroughCond");
  if (stEl) {
    destroy("sellThroughCond");
    charts.sellThroughCond = new Chart(stEl.getContext("2d"), {
      type: "bar",
      data: {
        labels: condLabels,
        datasets: [{
          label: "Sell-through %",
          data: condSellThrough,
          backgroundColor: "rgba(245,158,11,0.35)",
          borderColor: "rgba(255,255,255,0.18)",
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: common.color } } },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => `${v}%` }, grid: { color: common.grid }, min: 0, max: 100 }
        }
      }
    });
  }

  // Profit by Batch
  const batchEl = $("#batchBar");
  if (batchEl) {
    destroy("batchBar");
    charts.batchBar = new Chart(batchEl.getContext("2d"), {
      type: "bar",
      data: {
        labels: batchLabels.length ? batchLabels : ["—"],
        datasets: [{
          label: "Profit (Net Alloc.)",
          data: batchLabels.length ? batchProfitVals : [0],
          backgroundColor: (ctx) => (ctx.raw ?? 0) >= 0 ? "rgba(168,85,247,0.45)" : "rgba(239,68,68,0.55)",
          borderColor: "rgba(255,255,255,0.18)",
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: common.color } } },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } }
        }
      }
    });
  }

  // Spent vs Revenue by Batch
  const bsrEl = $("#batchSpendRev");
  if (bsrEl) {
    destroy("batchSpendRev");
    charts.batchSpendRev = new Chart(bsrEl.getContext("2d"), {
      type: "bar",
      data: {
        labels: batchSpendLabels.length ? batchSpendLabels : ["—"],
        datasets: [
          {
            label: "Spent (Purchase+Material+Fees)",
            data: batchSpendLabels.length ? batchSpendVals : [0],
            backgroundColor: "rgba(239,68,68,0.35)",
            borderColor: "rgba(255,255,255,0.18)",
            borderWidth: 1
          },
          {
            label: "Revenue",
            data: batchSpendLabels.length ? batchRevVals : [0],
            backgroundColor: "rgba(34,197,94,0.35)",
            borderColor: "rgba(255,255,255,0.18)",
            borderWidth: 1
          }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: common.color } } },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } }
        }
      }
    });
  }

  // Buyer Breakdown
  const buyerEl = $("#buyerBar");
  if (buyerEl) {
    destroy("buyerBar");
    charts.buyerBar = new Chart(buyerEl.getContext("2d"), {
      type: "bar",
      data: {
        labels: buyerLabels.length ? buyerLabels : ["—"],
        datasets: [{
          label: "Revenue",
          data: buyerLabels.length ? buyerVals : [0],
          backgroundColor: "rgba(59,130,246,0.35)",
          borderColor: "rgba(255,255,255,0.18)",
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: common.color } } },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } }
        }
      }
    });
  }

  // Fees + Shipping Over Time
  const feesEl = $("#feesLine");
  if (feesEl) {
    destroy("feesLine");
    charts.feesLine = new Chart(feesEl.getContext("2d"), {
      type: "line",
      data: {
        labels: months.length ? months : ["—"],
        datasets: [{
          label: "Fees + Shipping",
          data: months.length ? feesTotalByMonthArr : [0],
          borderColor: "rgba(245,158,11,0.95)",
          backgroundColor: "rgba(245,158,11,0.18)",
          fill: true,
          tension: 0.25,
          pointRadius: 3
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: common.color } } },
        scales: {
          x: { ticks: { color: common.color }, grid: { color: common.grid } },
          y: { ticks: { color: common.color, callback: (v) => money(v) }, grid: { color: common.grid } }
        }
      }
    });
  }
}

/** ---------- Export / Import (JSON + CSV) ---------- */
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
  a.download = `lego-flip-tracker-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Exported 📦");
}

async function importData(file) {
  const text = await file.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { toast("Invalid JSON file."); return; }

  const inv = parsed?.inventory;
  const sa = parsed?.sales;
  const ex = parsed?.expenses;

  // Backward compatible: if old "flips" exists, skip (your project migrated earlier; not needed here)

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
        boxIncluded: (raw.boxIncluded === "no" ? "no" : "yes"),
        manualIncluded: (raw.manualIncluded === "no" ? "no" : "yes"),
        createdAt: toNum(raw.createdAt) || Date.now(),
        updatedAt: Date.now()
      };
      if (!item.name || !item.purchaseDate) continue;
      await txPut(INVENTORY_STORE, item);
    }
  }

  if (Array.isArray(sa)) {
    for (const raw of sa) {
      const s = {
        id: raw.id || uid(),
        inventoryId: (raw.inventoryId || "").trim(),
        soldDate: raw.soldDate || "",
        soldPrice: toNum(raw.soldPrice),
        fees: toNum(raw.fees),
        soldOn: (raw.soldOn || "").trim(),
        sellPayment: (raw.sellPayment || "").trim(),
        buyer: (raw.buyer || "").trim(),
        notes: (raw.notes || "").trim(),
        createdAt: toNum(raw.createdAt) || Date.now(),
        updatedAt: Date.now()
      };
      if (!s.inventoryId || !s.soldDate || s.soldPrice <= 0) continue;
      await txPut(SALES_STORE, s);
    }
  }

  if (Array.isArray(ex)) {
    for (const raw of ex) {
      const e = {
        id: raw.id || uid(),
        amount: toNum(raw.amount),
        category: (raw.category || "Other").trim() || "Other",
        date: raw.date || "",
        note: (raw.note || "").trim(),
        createdAt: toNum(raw.createdAt) || Date.now()
      };
      if (!e.date || e.amount <= 0) continue;
      await txPut(EXPENSES_STORE, e);
    }
  }

  await reloadAll();
  toast("Imported ✅");
}

function parseCSV(text) {
  // Simple CSV parser (handles quotes)
  const rows = [];
  let cur = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; continue; }
      if (ch === '"') { inQuotes = false; continue; }
      field += ch;
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { cur.push(field); field = ""; continue; }
    if (ch === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; continue; }
    if (ch === "\r") continue;
    field += ch;
  }
  cur.push(field);
  rows.push(cur);

  // Trim empty trailing lines
  return rows.filter(r => r.some(c => String(c).trim() !== ""));
}

async function importCSV(file) {
  const text = await file.text();
  const rows = parseCSV(text);
  if (!rows.length) return toast("Empty CSV.");

  const headers = rows[0].map(h => String(h).trim());
  const idx = (name) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());

  // Supported columns:
  // setNumber,name,setImageUrl,purchaseDate,purchaseCost,materialCost,condition,batch,boughtFrom,buyPayment,boxIncluded,manualIncluded
  // soldDate,soldPrice,fees,soldOn,sellPayment,buyer,notes
  const h = {
    setNumber: idx("setNumber"),
    name: idx("name"),
    setImageUrl: idx("setImageUrl"),
    purchaseDate: idx("purchaseDate"),
    purchaseCost: idx("purchaseCost"),
    materialCost: idx("materialCost"),
    condition: idx("condition"),
    batch: idx("batch"),
    boughtFrom: idx("boughtFrom"),
    buyPayment: idx("buyPayment"),
    boxIncluded: idx("boxIncluded"),
    manualIncluded: idx("manualIncluded"),
    soldDate: idx("soldDate"),
    soldPrice: idx("soldPrice"),
    fees: idx("fees"),
    soldOn: idx("soldOn"),
    sellPayment: idx("sellPayment"),
    buyer: idx("buyer"),
    notes: idx("notes")
  };

  const needsAny = Object.values(h).some(i => i >= 0);
  if (!needsAny) return toast("CSV headers not recognized.");

  // Optional: if name/img missing, try lookup (if API key exists) for up to 30 items
  const key = getRBKey();

  let lookupCount = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];

    const invId = uid();
    const setNumber = h.setNumber >= 0 ? (row[h.setNumber] || "").trim() : "";
    let name = h.name >= 0 ? (row[h.name] || "").trim() : "";
    let setImageUrl = h.setImageUrl >= 0 ? (row[h.setImageUrl] || "").trim() : "";

    const purchaseDate = h.purchaseDate >= 0 ? (row[h.purchaseDate] || "").trim() : "";
    const purchaseCost = h.purchaseCost >= 0 ? toNum(row[h.purchaseCost]) : 0;
    const materialCost = h.materialCost >= 0 ? toNum(row[h.materialCost]) : 0;

    // Condition in CSV can be label or key
    let condRaw = h.condition >= 0 ? (row[h.condition] || "").trim() : "";
    // Accept "Used (complete)" etc:
    if (condRaw && !CONDITION_LABELS[condRaw]) {
      const lower = condRaw.toLowerCase();
      if (lower.includes("sealed")) condRaw = "new_sealed";
      else if (lower.includes("open")) condRaw = "new_openbox";
      else if (lower.includes("complete")) condRaw = "used_complete";
      else if (lower.includes("incomplete")) condRaw = "used_incomplete";
    }
    const condition = normalizeCondition(condRaw);

    const batch = h.batch >= 0 ? normalizeBatch(row[h.batch]) : "";
    const boughtFrom = h.boughtFrom >= 0 ? (row[h.boughtFrom] || "").trim() : "";
    const buyPayment = h.buyPayment >= 0 ? (row[h.buyPayment] || "").trim() : "";
    const boxIncluded = h.boxIncluded >= 0 ? ((String(row[h.boxIncluded] || "").trim().toLowerCase() === "no") ? "no" : "yes") : "yes";
    const manualIncluded = h.manualIncluded >= 0 ? ((String(row[h.manualIncluded] || "").trim().toLowerCase() === "no") ? "no" : "yes") : "yes";

    // Lookup if missing and key exists
    if (key && setNumber && (!name || !setImageUrl) && lookupCount < 30) {
      const res = await rebrickableLookup(setNumber);
      if (res) {
        if (!name && res.name) name = res.name;
        if (!setImageUrl && res.img) setImageUrl = res.img;
      }
      lookupCount++;
    }

    const inv = {
      id: invId,
      name: name || "(unnamed)",
      setNumber,
      setImageUrl,
      purchaseDate,
      purchaseCost,
      materialCost,
      condition,
      batch,
      boughtFrom,
      buyPayment,
      boxIncluded,
      manualIncluded,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    if (!inv.purchaseDate) continue; // require purchaseDate
    await txPut(INVENTORY_STORE, inv);

    // Optional sale portion
    const soldDate = h.soldDate >= 0 ? (row[h.soldDate] || "").trim() : "";
    const soldPrice = h.soldPrice >= 0 ? toNum(row[h.soldPrice]) : 0;

    if (soldDate && soldPrice > 0) {
      const sale = {
        id: uid(),
        inventoryId: invId,
        soldDate,
        soldPrice,
        fees: h.fees >= 0 ? toNum(row[h.fees]) : 0,
        soldOn: h.soldOn >= 0 ? (row[h.soldOn] || "").trim() : "",
        sellPayment: h.sellPayment >= 0 ? (row[h.sellPayment] || "").trim() : "",
        buyer: h.buyer >= 0 ? (row[h.buyer] || "").trim() : "",
        notes: h.notes >= 0 ? (row[h.notes] || "").trim() : "",
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await txPut(SALES_STORE, sale);
    }
  }

  await reloadAll();
  toast("CSV imported ✅");
}

/** ---------- Misc UI helpers ---------- */
function todayStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** ---------- Main rerender ---------- */
function rerenderAll() {
  updateBatchFiltersFromInventory();
  renderInventoryDatalist();
  renderInventoryTable();
  renderExpenseSummary();
  rerenderStats();
}

/** ---------- Events wiring ---------- */
async function reloadAll() {
  inventory = await txGetAll(INVENTORY_STORE);
  sales = await txGetAll(SALES_STORE);
  expenses = await txGetAll(EXPENSES_STORE);
  renderExpensesTable();
  rerenderAll();
}

function setupFilters() {
  $("#searchInput")?.addEventListener("input", () => { renderInventoryTable(); });
  $("#statusFilter")?.addEventListener("change", () => { renderInventoryTable(); });
  $("#conditionFilter")?.addEventListener("change", () => { renderInventoryTable(); });
  $("#batchFilter")?.addEventListener("change", () => { renderInventoryTable(); });
}

function setupStatsFilters() {
  $("#statsRange")?.addEventListener("change", rerenderStats);
  $("#statsBatchFilter")?.addEventListener("change", rerenderStats);
}

function setupInventoryPick() {
  $("#invPick")?.addEventListener("input", async (e) => {
    const inv = findInventoryByPickValue(e.target.value);
    if (!inv) return;

    // Set hidden inventoryId
    const f = $("#saleForm");
    if (!f) return;
    f.inventoryId.value = inv.id;

    // Load sale if exists (so user can edit sold item)
    const sale = await txGetSaleByInventoryId(inv.id);
    fillSaleForm(inv, sale);
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
  setupTabs();

  // Default dates
  $("#invForm")?.querySelector('input[name="purchaseDate"]') && ($("#invForm").purchaseDate.value = todayStr());
  $("#saleForm")?.querySelector('input[name="soldDate"]') && ($("#saleForm").soldDate.value = todayStr());
  $("#expenseForm")?.querySelector('input[name="date"]') && ($("#expenseForm").date.value = todayStr());

  // API key
  $("#apiKeyBtn")?.addEventListener("click", async () => {
    const current = getRBKey();
    const entered = prompt("Rebrickable API key (stored locally in your browser):", current);
    if (entered === null) return;
    setRBKey(entered);
    toast(getRBKey() ? "API key saved ✅" : "API key cleared");
  });

  // Inventory lookup
  $("#invLookupBtn")?.addEventListener("click", async () => {
    const f = $("#invForm");
    if (!f) return;
    const setNum = f.setNumber.value;
    const res = await rebrickableLookup(setNum);
    if (!res) return;
    if (res.name) f.name.value = res.name;
    if (res.img) {
      f.setImageUrl.value = res.img;
      setPreview($("#invPhotoPreview"), res.img);
    }
    toast("Set info filled ✅");
  });

  // Forms
  $("#invForm")?.addEventListener("submit", saveInventory);
  $("#invResetBtn")?.addEventListener("click", resetInventoryForm);

  $("#saleForm")?.addEventListener("submit", saveSale);
  $("#saleResetBtn")?.addEventListener("click", resetSaleForm);

  $("#expenseForm")?.addEventListener("submit", addExpense);
  $("#expenseTbody")?.addEventListener("click", handleExpenseTableClick);
  $("#clearExpensesBtn")?.addEventListener("click", clearExpenses);

  // Tables
  $("#invTbody")?.addEventListener("click", handleInventoryTableClick);

  // Filters
  setupFilters();
  setupStatsFilters();
  setupInventoryPick();

  // Export/Import
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
    await importCSV(file);
    e.target.value = "";
  });

  // Init SW
  await registerSW();

  // Load data
  await reloadAll();

  // Hide previews initially
  setPreview($("#invPhotoPreview"), $("#invForm")?.setImageUrl?.value || "");
  setPreview($("#salePhotoPreview"), "");

  // Ensure stats render after Chart is ready
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (window.Chart) {
      clearInterval(t);
      rerenderStats();
    }
    if (tries > 40) clearInterval(t);
  }, 100);
}

init();



