const STORAGE_KEY = "kopma-kasir-data-v1";
const SYNC_SETTINGS_KEY = "kopma-kasir-google-sheets-v1";
const SHEETS_MARKER = "KOPMA_KASIR_V1";
const SHEETS_API_URL = "https://sheets.googleapis.com/v4/spreadsheets";
const currency = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric" });
const fullDateFormatter = new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const monthLongFormatter = new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric" });
const today = localDateValue(new Date());
let toastTimeout;
let state = loadState();
let dashboardPeriod = "day";
let currentBukuMode = "ledger";
let editingProductId = null;
let saleCart = [];
let receiptImage = null;
let receiptOcrWorker = null;
let tesseractLoadPromise = null;
let googleAccessToken = null;
let googleTokenExpiresAt = 0;
let googleTokenClient = null;
let syncConfig = loadSyncConfig();
let syncUploadQueue = Promise.resolve();

function localDateValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function loadState() {
  try {
    return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
  } catch (error) {
    console.error("Data kasir tidak dapat dibaca dari penyimpanan browser.", error);
    window.addEventListener("DOMContentLoaded", () => showToast("Data tersimpan tidak dapat dibaca. Silakan periksa penyimpanan browser.", true), { once: true });
    return { products: [], transactions: [] };
  }
}

function normalizeState(saved) {
  const products = Array.isArray(saved?.products) ? saved.products : [];
  const transactions = Array.isArray(saved?.transactions) ? saved.transactions : [];
  return {
    products: products.filter((item) => item && typeof item.id === "string" && typeof item.name === "string" && Number.isFinite(item.sellingPrice ?? item.price) && (item.sellingPrice ?? item.price) > 0).map((item) => ({
      ...item,
      sellingPrice: item.sellingPrice ?? item.price,
      buyPrice: Number.isSafeInteger(item.buyPrice) && item.buyPrice >= 0 ? item.buyPrice : null
    })),
    transactions: transactions.filter((item) => item && typeof item.id === "string" && typeof item.description === "string" && ["income", "expense"].includes(item.type) && Number.isFinite(item.amount) && item.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(item.date)).map((item) => ({
      ...item,
      ...(typeof item.receiptImage === "string" && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(item.receiptImage) ? { receiptImage: item.receiptImage } : {})
    }))
  };
}

function loadSyncConfig() {
  try {
    const settings = JSON.parse(localStorage.getItem(SYNC_SETTINGS_KEY) || "null");
    return settings && typeof settings.clientId === "string" && typeof settings.spreadsheetId === "string" ? settings : null;
  } catch (error) {
    console.error("Pengaturan Google Sheets tidak dapat dibaca.", error);
    return null;
  }
}

function persistState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (googleAccessToken && syncConfig) scheduleRemoteSave();
    return true;
  } catch (error) {
    console.error("Data kasir gagal disimpan ke penyimpanan browser.", error);
    showToast("Data gagal disimpan. Periksa ruang penyimpanan browser.", true);
    return false;
  }
}

function setSyncStatus(message, isError = false) {
  const status = document.getElementById("sync-status");
  if (status) {
    status.textContent = message;
    status.classList.toggle("sync-status-error", isError);
  }
  const button = document.getElementById("sync-settings-button");
  if (button) {
    button.querySelector("span:last-child").textContent = googleAccessToken ? "Sheets terhubung" : "Hubungkan Sheets";
    button.classList.toggle("is-connected", Boolean(googleAccessToken));
  }
}

function saveSyncConfig() {
  const clientId = document.getElementById("google-client-id").value.trim();
  const spreadsheetId = document.getElementById("google-sheet-id").value.trim();
  if (!clientId.endsWith(".apps.googleusercontent.com") || !spreadsheetId || /[^a-zA-Z0-9_-]/.test(spreadsheetId)) {
    showToast("Isi Google OAuth Client ID dan ID Spreadsheet dengan benar.", true);
    return false;
  }
  const updatedConfig = { clientId, spreadsheetId };
  try {
    localStorage.setItem(SYNC_SETTINGS_KEY, JSON.stringify(updatedConfig));
    if (syncConfig?.clientId !== clientId || syncConfig?.spreadsheetId !== spreadsheetId) {
      googleAccessToken = null;
      googleTokenExpiresAt = 0;
      googleTokenClient = null;
    }
    syncConfig = updatedConfig;
    setSyncStatus(googleAccessToken ? "Terhubung ke Google Sheets." : "Pengaturan tersimpan; login Google untuk menyinkronkan.");
    showToast("Pengaturan Google Sheets berhasil disimpan.");
    return true;
  } catch (error) {
    console.error("Pengaturan Google Sheets gagal disimpan.", error);
    showToast("Pengaturan gagal disimpan di browser.", true);
    return false;
  }
}

async function getGoogleAccessToken() {
  if (!syncConfig) throw new Error("Isi dan simpan Client ID serta ID Spreadsheet terlebih dahulu.");
  if (googleAccessToken && googleTokenExpiresAt > Date.now() + 60000) return googleAccessToken;
  let attempts = 0;
  while (!window.google?.accounts?.oauth2 && attempts < 50) {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    attempts += 1;
  }
  if (!window.google?.accounts?.oauth2) throw new Error("Layanan login Google belum termuat. Periksa koneksi internet lalu muat ulang halaman.");
  return new Promise((resolve, reject) => {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: syncConfig.clientId,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error_description || response.error || "Login Google tidak berhasil."));
          return;
        }
        googleAccessToken = response.access_token;
        googleTokenExpiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000;
        setSyncStatus("Login Google berhasil; pilih ambil atau kirim data.");
        resolve(googleAccessToken);
      },
      error_callback: (error) => reject(new Error(error.message || "Jendela login Google tidak berhasil dibuka."))
    });
    googleTokenClient = tokenClient;
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

async function sheetsRequest(path, options = {}) {
  const token = await getGoogleAccessToken();
  const response = await fetch(`${SHEETS_API_URL}/${encodeURIComponent(syncConfig.spreadsheetId)}/values/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers
    }
  });
  if (!response.ok) {
    let details = "";
    try {
      const result = await response.json();
      details = result.error?.message || "";
    } catch (error) {
      console.error("Rincian kesalahan Google Sheets tidak dapat dibaca.", error);
    }
    if (response.status === 401) {
      googleAccessToken = null;
      googleTokenExpiresAt = 0;
    }
    throw new Error(details || `Google Sheets menolak permintaan (${response.status}). Pastikan Sheets API aktif dan akunmu memiliki akses ke spreadsheet.`);
  }
  return response.json();
}

async function readRemoteState() {
  const result = await sheetsRequest("A1%3AA2");
  const values = result.values || [];
  if (!values.length || !values[0]?.[0]) return null;
  if (values[0][0] !== SHEETS_MARKER || typeof values[1]?.[0] !== "string") {
    throw new Error("Sheet ini sudah berisi data lain atau belum disiapkan Kopma Kasir. Gunakan spreadsheet kosong khusus untuk aplikasi.");
  }
  let remote;
  try {
    remote = normalizeState(JSON.parse(values[1][0]));
  } catch (error) {
    console.error("Data pada Google Sheets tidak valid.", error);
    throw new Error("Data kasir di Sheet tidak dapat dibaca. Data lokal tidak diubah.");
  }
  return remote;
}

async function writeRemoteState(snapshot) {
  const remoteSnapshot = {
    ...snapshot,
    transactions: snapshot.transactions.map(({ receiptImage: _receiptImage, ...transaction }) => transaction)
  };
  const data = JSON.stringify(remoteSnapshot);
  if (data.length > 45000) throw new Error("Data terlalu besar untuk satu sel Google Sheets. Hubungi saya untuk metode penyimpanan lain.");
  const body = { values: [[SHEETS_MARKER], [data]] };
  await sheetsRequest("A1%3AA2?valueInputOption=RAW", { method: "PUT", body: JSON.stringify(body) });
}

function scheduleRemoteSave() {
  const snapshot = JSON.parse(JSON.stringify(state));
  syncUploadQueue = syncUploadQueue
    .then(() => writeRemoteState(snapshot))
    .then(() => setSyncStatus("Perubahan terakhir tersimpan ke Google Sheets."))
    .catch((error) => {
      console.error("Perubahan tidak dapat disinkronkan ke Google Sheets.", error);
      setSyncStatus(error.message, true);
      showToast(`Data lokal tersimpan, tetapi sinkronisasi gagal: ${error.message}`, true);
    });
}

async function connectGoogleSheets() {
  if (!saveSyncConfig()) return;
  try {
    await getGoogleAccessToken();
  } catch (error) {
    console.error("Login Google gagal.", error);
    setSyncStatus(error.message, true);
    showToast(error.message, true);
  }
}

async function uploadToGoogleSheets() {
  if (!saveSyncConfig()) return;
  try {
    const remote = await readRemoteState();
    const hasRemoteData = remote && (remote.products.length || remote.transactions.length);
    if (hasRemoteData && !window.confirm("Google Sheet sudah memiliki data. Ganti seluruh data Sheet dengan data pada perangkat ini?")) return;
    await writeRemoteState(state);
    setSyncStatus("Data perangkat ini berhasil dikirim ke Google Sheets.");
    showToast("Data berhasil dikirim ke Google Sheets.");
  } catch (error) {
    console.error("Data gagal dikirim ke Google Sheets.", error);
    setSyncStatus(error.message, true);
    showToast(error.message, true);
  }
}

async function downloadFromGoogleSheets() {
  if (!saveSyncConfig()) return;
  try {
    const remote = await readRemoteState();
    if (!remote) throw new Error("Sheet belum berisi data kasir. Isi data dari laptop lalu pilih Kirim ke Sheet terlebih dahulu.");
    const hasLocalData = state.products.length || state.transactions.length;
    if (hasLocalData && !window.confirm("Data lokal pada perangkat ini akan diganti dengan data dari Google Sheets. Lanjutkan?")) return;
    state = remote;
    if (!persistState()) throw new Error("Data Sheet terbaca, tetapi gagal disimpan di browser perangkat ini.");
    renderAll();
    setSyncStatus("Data berhasil diambil dari Google Sheets.");
    showToast("Data dari Google Sheets berhasil dimuat.");
  } catch (error) {
    console.error("Data gagal diambil dari Google Sheets.", error);
    setSyncStatus(error.message, true);
    showToast(error.message, true);
  }
}

function exportLocalBackup() {
  const backup = {
    format: "kopma-kasir-backup",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    data: state
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `kopma-kasir-backup-${today}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("Cadangan barang dan transaksi berhasil diunduh.");
}

async function importLocalBackup(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showToast("Berkas cadangan terlalu besar untuk diimpor.", true);
    return;
  }
  try {
    const backup = JSON.parse(await file.text());
    if (backup?.format !== "kopma-kasir-backup" || backup.schemaVersion !== 1 || !Array.isArray(backup.data?.products) || !Array.isArray(backup.data?.transactions)) {
      throw new Error("Format cadangan tidak dikenali atau berkasnya tidak lengkap.");
    }
    const imported = normalizeState(backup.data);
    if (imported.products.length !== backup.data.products.length || imported.transactions.length !== backup.data.transactions.length) {
      throw new Error("Sebagian data pada cadangan tidak valid; data perangkat tidak diubah.");
    }
    if (!window.confirm(`Pulihkan ${imported.products.length} barang dan ${imported.transactions.length} transaksi? Data saat ini di perangkat ini akan diganti.`)) return;
    const previousState = state;
    state = imported;
    if (!persistState()) {
      state = previousState;
      return;
    }
    renderAll();
    showToast("Cadangan berhasil dipulihkan ke perangkat ini.");
  } catch (error) {
    console.error("Cadangan kasir tidak dapat dipulihkan.", error);
    showToast(error.message || "Berkas cadangan tidak dapat dibaca.", true);
  }
}

function showToast(message, isError = false) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("show"), 2800);
}

function formatDate(value, formatter = dateFormatter) {
  const [year, month, day] = value.split("-").map(Number);
  return formatter.format(new Date(year, month - 1, day));
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function getPeriodTransactions(period, value) {
  return state.transactions.filter((item) => period === "day" ? item.date === value : item.date.startsWith(value));
}

function totals(transactions) {
  const income = transactions.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amount, 0);
  const expense = transactions.filter((item) => item.type === "expense").reduce((sum, item) => sum + item.amount, 0);
  return { income, expense, balance: income - expense, count: transactions.length };
}

function renderDashboard() {
  const selectedDate = document.getElementById("dashboard-date").value || today;
  const periodValue = dashboardPeriod === "day" ? selectedDate : selectedDate.slice(0, 7);
  const entries = getPeriodTransactions(dashboardPeriod, periodValue);
  const summary = totals(entries);
  document.getElementById("income-total").textContent = currency.format(summary.income);
  document.getElementById("expense-total").textContent = currency.format(summary.expense);
  document.getElementById("balance-total").textContent = currency.format(summary.balance);
  document.getElementById("transaction-count").textContent = summary.count.toLocaleString("id-ID");
  document.getElementById("period-label").textContent = dashboardPeriod === "day" ? "Pilih tanggal" : "Pilih bulan";
  document.getElementById("dashboard-date").type = dashboardPeriod === "day" ? "date" : "month";
  document.getElementById("chart-subtitle").textContent = dashboardPeriod === "day" ? "Pemasukan & pengeluaran 7 hari terakhir" : "Pemasukan & pengeluaran per rentang tanggal";
  renderChart(selectedDate);
  renderRecent();
}

function renderChart(selectedDate) {
  const monthValue = selectedDate.slice(0, 7);
  const [year, month] = monthValue.split("-").map(Number);
  let buckets;
  if (dashboardPeriod === "month") {
    const days = new Date(year, month, 0).getDate();
    const step = Math.max(1, Math.ceil(days / 7));
    buckets = Array.from({ length: Math.ceil(days / step) }, (_, index) => {
      const startDay = index * step + 1;
      const endDay = Math.min(days, startDay + step - 1);
      return { label: `${startDay}`, dateStart: `${monthValue}-${String(startDay).padStart(2, "0")}`, dateEnd: `${monthValue}-${String(endDay).padStart(2, "0")}` };
    });
  } else {
    const selected = new Date(year, month - 1, Number(selectedDate.slice(8, 10)));
    buckets = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(selected);
      date.setDate(selected.getDate() - (6 - index));
      return { label: new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short" }).format(date), dateStart: localDateValue(date), dateEnd: localDateValue(date) };
    });
  }
  const values = buckets.map((bucket) => {
    const items = state.transactions.filter((item) => item.date >= bucket.dateStart && item.date <= bucket.dateEnd);
    return { ...bucket, ...totals(items) };
  });
  const max = Math.max(1, ...values.flatMap((item) => [item.income, item.expense]));
  document.getElementById("cash-chart").innerHTML = values.map((item) => `
    <div class="chart-column" title="${escapeHTML(item.label)}: masuk ${currency.format(item.income)}, keluar ${currency.format(item.expense)}">
      <div class="bar-pair"><span class="bar" style="height:${Math.max(item.income ? 4 : 0, item.income / max * 100)}%"></span><span class="bar out" style="height:${Math.max(item.expense ? 4 : 0, item.expense / max * 100)}%"></span></div>
      <span class="chart-label">${escapeHTML(item.label)}</span>
    </div>`).join("");
}

function transactionRow(item) {
  const income = item.type === "income";
  const type = income ? "income" : "expense";
  return `<tr>
    <td><div class="transaction-name"><span class="transaction-icon ${type}">${income ? "↗" : "↙"}</span>${escapeHTML(item.description)}${item.receiptImage ? `<button class="receipt-view-button" type="button" data-view-receipt="${escapeHTML(item.id)}">Lihat nota</button>` : ""}</div></td>
    <td><span class="type-badge ${type}"><span>${income ? "↗" : "↙"}</span>${income ? "Uang masuk" : "Uang keluar"}</span></td>
    <td>${formatDate(item.date)}</td>
    <td class="align-right ${income ? "amount-in" : "amount-out"}">${income ? "+" : "−"}${currency.format(item.amount)}</td>
  </tr>`;
}

function renderRecent() {
  const target = document.getElementById("recent-transactions");
  const recent = [...state.transactions].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  target.innerHTML = recent.length ? `<div class="table-wrap"><table><thead><tr><th>KETERANGAN</th><th>JENIS</th><th>TANGGAL</th><th class="align-right">JUMLAH</th></tr></thead><tbody>${recent.map(transactionRow).join("")}</tbody></table></div>` : `<div class="empty-state show"><span class="empty-icon">↕</span><strong>Belum ada transaksi</strong><p>Transaksi terbarumu akan muncul di sini.</p></div>`;
}

function renderProducts() {
  const query = document.getElementById("product-search").value.trim().toLocaleLowerCase("id");
  const products = [...state.products].sort((a, b) => a.name.localeCompare(b.name, "id"));
  const filtered = products.filter((item) => item.name.toLocaleLowerCase("id").includes(query));
  document.getElementById("product-count").textContent = products.length.toLocaleString("id-ID");
  const rows = document.getElementById("product-rows");
  rows.innerHTML = filtered.map((item) => `<tr>
    <td><div class="product-name-cell"><span class="product-thumb">▤</span>${escapeHTML(item.name)}</div></td>
    <td>${item.buyPrice === null ? '<span class="legacy-price">Belum diatur</span>' : currency.format(item.buyPrice)}</td>
    <td class="amount-in">${currency.format(item.sellingPrice)}</td>
    <td><span class="profit-badge ${item.buyPrice === null ? "profit-unknown" : item.sellingPrice >= item.buyPrice ? "profit-positive" : "profit-negative"}">${item.buyPrice === null ? "—" : currency.format(item.sellingPrice - item.buyPrice)}</span></td>
    <td>${formatDate(item.createdAt.slice(0, 10))}</td>
    <td class="align-right product-actions"><button class="text-button edit-product" data-edit-product="${escapeHTML(item.id)}" aria-label="Ubah ${escapeHTML(item.name)}">Ubah</button><button class="text-button sell-product" data-product-id="${escapeHTML(item.id)}" aria-label="Catat penjualan ${escapeHTML(item.name)}">Catat jual</button><button class="product-delete" data-delete-product="${escapeHTML(item.id)}" aria-label="Hapus ${escapeHTML(item.name)}">×</button></td>
  </tr>`).join("");
  const empty = document.getElementById("products-empty");
  empty.classList.toggle("show", filtered.length === 0);
  empty.querySelector("strong").textContent = products.length && query ? "Barang tidak ditemukan" : "Belum ada barang";
  empty.querySelector("p").textContent = products.length && query ? "Coba kata kunci pencarian yang lain." : "Tambahkan barang pertamamu lewat formulir di sebelah.";
}

function renderTransactions() {
  const kind = document.getElementById("transaction-filter").value;
  const month = document.getElementById("transaction-date-filter").value;
  const filtered = [...state.transactions]
    .filter((item) => (kind === "all" || item.type === kind) && (!month || item.date.startsWith(month)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  document.getElementById("transaction-rows").innerHTML = filtered.map(transactionRow).join("");
  document.getElementById("transactions-empty").classList.toggle("show", filtered.length === 0);
  document.querySelector("#transactions-empty strong").textContent = state.transactions.length ? "Transaksi tidak ditemukan" : "Belum ada transaksi";
  document.querySelector("#transactions-empty p").textContent = state.transactions.length ? "Coba ubah filter jenis atau bulan." : "Transaksi yang kamu catat akan muncul di sini.";
}

function formatMoneyText(amount) {
  if (amount === 0 || amount === null || amount === undefined || isNaN(amount)) return "Rp 0";
  const prefix = amount < 0 ? "-Rp " : "Rp ";
  return `${prefix}${Math.abs(amount).toLocaleString("id-ID")}`;
}

function formatCellMoneyHtml(amount) {
  if (amount === 0 || amount === null || amount === undefined || isNaN(amount)) {
    return `<span class="cell-money"><span class="cell-curr">Rp</span><span class="cell-num">-</span></span>`;
  }
  const isNeg = amount < 0;
  const numStr = Math.abs(amount).toLocaleString("id-ID");
  const prefix = isNeg ? "-Rp" : "Rp";
  return `<span class="cell-money"><span class="cell-curr">${prefix}</span><span class="cell-num">${numStr}</span></span>`;
}

function renderReport() {
  const month = document.getElementById("report-month").value || today.slice(0, 7);
  const [yearStr, monthStr] = month.split("-");
  const monthDate = new Date(Number(yearStr), Number(monthStr) - 1, 1);
  const monthUpper = monthLongFormatter.format(monthDate).toUpperCase();

  // Update Judul Sheet: BULAN [BULAN] [TAHUN]
  const titleEl = document.getElementById("sheet-month-label");
  if (titleEl) titleEl.textContent = `BULAN ${monthUpper}`;

  // 1. Saldo awal sebelum bulan ini
  const priorTransactions = state.transactions.filter((t) => t.date < `${month}-01`);
  const startingIncome = priorTransactions.filter((t) => t.type === "income").reduce((sum, t) => sum + t.amount, 0);
  const startingExpense = priorTransactions.filter((t) => t.type === "expense").reduce((sum, t) => sum + t.amount, 0);
  const startingBalance = startingIncome - startingExpense;

  // 2. Transaksi bulan ini (urut kronologis terlama ke terbaru)
  const currentEntries = state.transactions
    .filter((t) => t.date.startsWith(month))
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));

  const totalIncome = currentEntries.filter((t) => t.type === "income").reduce((sum, t) => sum + t.amount, 0);
  const totalExpense = currentEntries.filter((t) => t.type === "expense").reduce((sum, t) => sum + t.amount, 0);
  const endingBalance = startingBalance + totalIncome - totalExpense;

  // 3. Update summary card di atas
  const startEl = document.getElementById("buku-starting-balance");
  if (startEl) startEl.textContent = formatMoneyText(startingBalance);
  document.getElementById("report-income").textContent = formatMoneyText(totalIncome);
  document.getElementById("report-expense").textContent = formatMoneyText(totalExpense);
  document.getElementById("report-balance").textContent = formatMoneyText(endingBalance);
  const countEl = document.getElementById("report-count");
  if (countEl) countEl.textContent = currentEntries.length.toString();

  // 4. Hitung baris-baris Buku Kas dengan saldo berjalan
  let running = startingBalance;
  const ledger = currentEntries.map((item) => {
    if (item.type === "income") running += item.amount;
    else running -= item.amount;
    return {
      ...item,
      runningBalance: running
    };
  });

  const tbodyEl = document.getElementById("buku-kas-rows");
  const tfootEl = document.getElementById("buku-kas-tfoot");

  let rowsHtml = "";

  // Tampilkan saldo awal bulan jika ada saldo awal atau jika belum ada transaksi
  if (startingBalance !== 0 || ledger.length === 0) {
    rowsHtml += `<tr class="sheet-row-initial">
      <td class="col-tgl align-center">-</td>
      <td class="col-uraian"><em>Saldo Awal Bulan</em></td>
      <td class="col-pemasukan align-right">${formatCellMoneyHtml(0)}</td>
      <td class="col-pengeluaran align-right">${formatCellMoneyHtml(0)}</td>
      <td class="col-saldo align-right"><strong>${formatCellMoneyHtml(startingBalance)}</strong></td>
    </tr>`;
  }

  // Tampilkan setiap transaksi persis seperti format gambar buku kas
  let lastDay = "";
  ledger.forEach((item) => {
    const isIncome = item.type === "income";
    const dayNum = Number(item.date.slice(8, 10));
    // TGL hanya muncul pada baris pertama untuk hari yang sama, baris berikutnya kosong (persis di gambar user!)
    const showDay = item.date !== lastDay;
    lastDay = item.date;

    rowsHtml += `<tr>
      <td class="col-tgl align-center">${showDay ? dayNum : ""}</td>
      <td class="col-uraian">
        <span class="sheet-desc-text">${escapeHTML(item.description)}</span>
        ${item.receiptImage ? `<button class="receipt-view-button" type="button" data-view-receipt="${escapeHTML(item.id)}" title="Lihat foto nota">📎 Nota</button>` : ""}
      </td>
      <td class="col-pemasukan align-right ${isIncome ? "cell-amount-in" : ""}">${formatCellMoneyHtml(isIncome ? item.amount : 0)}</td>
      <td class="col-pengeluaran align-right ${!isIncome ? "cell-amount-out" : ""}">${formatCellMoneyHtml(!isIncome ? item.amount : 0)}</td>
      <td class="col-saldo align-right"><strong>${formatCellMoneyHtml(item.runningBalance)}</strong></td>
    </tr>`;
  });

  if (tbodyEl) tbodyEl.innerHTML = rowsHtml;

  // Baris TOTAL di bawah (tfoot)
  if (tfootEl) {
    tfootEl.innerHTML = `<tr class="sheet-total-row">
      <th colspan="2" class="align-center">TOTAL</th>
      <th class="col-pemasukan align-right ${totalIncome > 0 ? "cell-amount-in" : ""}">${formatCellMoneyHtml(totalIncome)}</th>
      <th class="col-pengeluaran align-right ${totalExpense > 0 ? "cell-amount-out" : ""}">${formatCellMoneyHtml(totalExpense)}</th>
      <th class="col-saldo align-right"><strong>${formatCellMoneyHtml(endingBalance)}</strong></th>
    </tr>`;
  }

  const emptyEl = document.getElementById("reports-empty");
  if (emptyEl) {
    emptyEl.classList.toggle("show", ledger.length === 0 && startingBalance === 0);
  }

  prepareReportPrint();
}

function prepareReportPrint() {
  const dateLabel = document.getElementById("print-date-label");
  if (dateLabel) {
    const now = new Date();
    const timeStr = String(now.getHours()).padStart(2, "0") + "." + String(now.getMinutes()).padStart(2, "0") + " WIB";
    dateLabel.textContent = formatDate(localDateValue(now), fullDateFormatter) + ", " + timeStr;
  }
}

function renderAll() {
  renderDashboard();
  renderProducts();
  renderTransactions();
  renderReport();
}

function openTransaction(type) {
  const form = document.getElementById("transaction-form");
  form.reset();
  receiptImage = null;
  currentOcrCanvas = null;
  resetReceiptPreview();
  form.elements.date.value = today;
  if (type === "income" || type === "expense") form.elements.type.value = type;
  saleCart = [];
  renderSaleProductOptions();
  updateTransactionMode();
  document.getElementById("transaction-dialog").showModal();
  if (form.elements.type.value === "expense") {
    preloadReceiptOcr();
  }
  if (window.innerWidth > 768 && form.elements.type.value === "income" && document.getElementById("income-mode").value === "sale") {
    document.getElementById("sale-product-select").focus();
  } else {
    if (window.innerWidth > 768) form.elements.description.focus();
  }
}

function renderSaleProductOptions() {
  const select = document.getElementById("sale-product-select");
  select.innerHTML = state.products.length
    ? `<option value="">Pilih barang...</option>${[...state.products].sort((a, b) => a.name.localeCompare(b.name, "id")).map((product) => `<option value="${escapeHTML(product.id)}">${escapeHTML(product.name)} — ${currency.format(product.sellingPrice)}</option>`).join("")}`
    : '<option value="">Belum ada barang</option>';
  document.getElementById("sale-empty-products").hidden = state.products.length > 0;
  document.getElementById("add-sale-item").disabled = state.products.length === 0;
  renderSaleCart();
}

function updateTransactionMode() {
  const type = document.getElementById("transaction-type").value;
  const isIncome = type === "income";
  const isSale = isIncome && document.getElementById("income-mode").value === "sale";
  document.getElementById("income-mode-group").hidden = !isIncome;
  document.getElementById("sale-panel").hidden = !isSale;
  document.getElementById("transaction-manual-fields").hidden = isSale;
  document.getElementById("expense-receipt-panel").hidden = !(!isSale && !isIncome);
  if (!isSale && !isIncome) {
    preloadReceiptOcr();
  }
  document.getElementById("transaction-description").required = !isSale;
  document.getElementById("transaction-amount").required = !isSale;
  renderSaleCart();
}

let tesseractLoadPromise = null;
let receiptOcrWorker = null;
let receiptWorkerInitPromise = null;
let currentOcrCanvas = null;

function resetReceiptPreview() {
  const previewWrap = document.getElementById("receipt-preview-wrap");
  if (previewWrap) previewWrap.hidden = true;
  const preview = document.getElementById("receipt-preview");
  if (preview) preview.removeAttribute("src");
  const laser = document.getElementById("receipt-scan-laser");
  if (laser) laser.hidden = true;
  const progBar = document.getElementById("receipt-progress-bar");
  if (progBar) progBar.hidden = true;
  const scanBtn = document.getElementById("scan-receipt");
  if (scanBtn) {
    scanBtn.hidden = true;
    scanBtn.disabled = false;
    scanBtn.textContent = "🔄 Pindai ulang";
  }
  const removeBtn = document.getElementById("remove-receipt");
  if (removeBtn) removeBtn.hidden = true;
  const pill = document.getElementById("receipt-status-pill");
  if (pill) {
    pill.className = "receipt-status-pill status-ready";
    const icon = document.getElementById("receipt-status-icon");
    if (icon) icon.textContent = "📷";
    const text = document.getElementById("receipt-status-text");
    if (text) text.textContent = "Foto siap";
  }
  const statusEl = document.getElementById("receipt-status");
  if (statusEl) statusEl.textContent = "Foto nota tersimpan di perangkat ini.";
}

function prepareReceiptImages(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);

      // 1. Storage image: Clean JPEG max 1200px (ramah kapasitas localStorage)
      const displayScale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight));
      const displayCanvas = document.createElement("canvas");
      displayCanvas.width = Math.round(image.naturalWidth * displayScale);
      displayCanvas.height = Math.round(image.naturalHeight * displayScale);
      const displayCtx = displayCanvas.getContext("2d");
      if (!displayCtx) {
        reject(new Error("Browser tidak dapat memproses gambar."));
        return;
      }
      displayCtx.drawImage(image, 0, 0, displayCanvas.width, displayCanvas.height);
      const storageDataUrl = displayCanvas.toDataURL("image/jpeg", 0.78);

      // 2. OCR image: High-contrast canvas max 1800px untuk ketajaman font nota
      const ocrScale = Math.min(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight));
      const ocrCanvas = document.createElement("canvas");
      ocrCanvas.width = Math.round(image.naturalWidth * ocrScale);
      ocrCanvas.height = Math.round(image.naturalHeight * ocrScale);
      const ocrCtx = ocrCanvas.getContext("2d", { willReadFrequently: true });
      ocrCtx.drawImage(image, 0, 0, ocrCanvas.width, ocrCanvas.height);

      // Tingkatkan kontras dan ketajaman teks nota
      try {
        const imgData = ocrCtx.getImageData(0, 0, ocrCanvas.width, ocrCanvas.height);
        const data = imgData.data;
        for (let i = 0; i < data.length; i += 4) {
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          let val = lum;
          if (lum < 115) {
            val = lum * 0.72; // pekatkan tulisan gelap
          } else if (lum > 140) {
            val = Math.min(255, lum * 1.18); // cerahkan kertas nota
          }
          data[i] = val;
          data[i + 1] = val;
          data[i + 2] = val;
        }
        ocrCtx.putImageData(imgData, 0, 0);
      } catch (e) {
        console.warn("OCR image enhancement skipped:", e);
      }

      resolve({ storageDataUrl, ocrCanvas });
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Foto tidak dapat dibuka. Gunakan format JPG, PNG, atau WebP."));
    };
    image.src = objectUrl;
  });
}

function findReceiptData(rawText) {
  if (!rawText || typeof rawText !== "string") return { amount: null, merchant: null };

  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { amount: null, merchant: null };

  // Deteksi nama toko/merchant dari 4 baris teratas
  let merchant = null;
  const topLines = lines.slice(0, 4);
  for (const line of topLines) {
    const clean = line.replace(/[^a-zA-Z0-9\s&.-]/g, "").trim();
    if (clean.length >= 3 && clean.length <= 40 && !/\d{5,}/.test(clean) && !/tanggal|waktu|kasir|struk|nota|order|receipt|meja|pos|invoice/i.test(clean)) {
      merchant = clean;
      break;
    }
  }

  // Pola kata kunci nota kasir & nota kontan Indonesia
  const highKw = /(?:grand\s*total|g[\.\s]*total|total\s*(?:belanja|bayar|tagihan|akhir|harga|keseluruhan|pembayaran)|jumlah\s*(?:total|belanja|bayar|tagihan|keseluruhan)|t[o0]t[a4][l1i]\s*(?:belanja|bayar|tagihan)?)/i;
  const mediumKw = /\b(?:total|t[o0]t[a4][l1i]|jumlah|jml|juml4h|jumi_ah|tagihan|dibayar|bayar|netto|net)\b/i;
  const subtotalKw = /\b(?:subtotal|sub\s*total|sub-total)\b/i;
  const cashKw = /\b(?:tunai|cash)\b/i;
  const negativeKw = /\b(?:kembali|kembalian|change|diskon|discount|hemat|potongan)\b/i;

  const numberPattern = /(?:rp\.?\s*)?(\d[\d\.,\s]{1,16}\d|\d+)(?:\s*[,-])?/gi;

  function extractNumbers(lineStr) {
    const found = [];
    const matches = [...lineStr.matchAll(numberPattern)];
    for (const m of matches) {
      let s = m[1].trim();
      // Potong desimal sen ,00 atau .00 jika ada
      if (/[.,]00$/.test(s)) {
        s = s.slice(0, -3);
      }
      const digits = s.replace(/[^\d]/g, "");
      if (digits && digits.length <= 10) {
        const val = Number(digits);
        // Rentang nominal belanja wajar: Rp 500 sampai Rp 100.000.000
        if (Number.isSafeInteger(val) && val >= 500 && val <= 100000000) {
          // Hindari no HP yang diawali 08 (panjang >= 10)
          if (!digits.startsWith("08") || digits.length < 10) {
            found.push(val);
          }
        }
      }
    }
    return found;
  }

  const candidates = [];

  // Tahap 1: Pencocokan baris per baris berdasarkan kata kunci
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isNegative = negativeKw.test(line);
    const hasHigh = highKw.test(line);
    const hasMedium = mediumKw.test(line);
    const hasSub = subtotalKw.test(line);
    const hasCash = cashKw.test(line);

    let nums = extractNumbers(line);

    // Multi-baris: jika kata kunci di baris i dan nominal di baris i+1
    if ((hasHigh || hasMedium) && !nums.length && i + 1 < lines.length) {
      const nextNums = extractNumbers(lines[i + 1]);
      if (nextNums.length) nums = nextNums;
    }

    if (nums.length) {
      let score = 0;
      if (hasHigh) score = 10;
      else if (hasMedium) score = 8;
      else if (hasSub) score = 5;
      else if (hasCash) score = 3;

      if (isNegative && !hasHigh) {
        score = -1; // lewati uang kembali
      }

      if (score > 0) {
        // Angka terakhir pada baris total biasanya adalah nominal final
        candidates.push({ amount: nums[nums.length - 1], score, line });
      }
    }
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score || b.amount - a.amount);
    return { amount: candidates[0].amount, merchant, confidence: "high" };
  }

  // Tahap 2 (Fallback): Cari angka terbesar di 60% bagian bawah nota
  const startIndex = Math.floor(lines.length * 0.4);
  const bottomNums = [];
  for (let i = startIndex; i < lines.length; i++) {
    if (negativeKw.test(lines[i])) continue;
    for (const val of extractNumbers(lines[i])) {
      bottomNums.push({ amount: val, lineIndex: i });
    }
  }

  if (bottomNums.length) {
    bottomNums.sort((a, b) => b.amount - a.amount || b.lineIndex - a.lineIndex);
    return { amount: bottomNums[0].amount, merchant, confidence: "medium" };
  }

  return { amount: null, merchant, confidence: "none" };
}

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!tesseractLoadPromise) {
    tesseractLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
      script.async = true;
      script.onload = () => resolve(window.Tesseract);
      script.onerror = () => {
        tesseractLoadPromise = null;
        reject(new Error("Pembaca nota tidak dapat dimuat. Periksa koneksi internet lalu coba lagi."));
      };
      document.head.append(script);
    });
  }
  return tesseractLoadPromise;
}

async function getReceiptWorker(onProgress) {
  if (receiptOcrWorker) return receiptOcrWorker;
  if (receiptWorkerInitPromise) return receiptWorkerInitPromise;

  receiptWorkerInitPromise = (async () => {
    const tesseract = await loadTesseract();
    const attempts = [
      { lang: "ind", path: "https://tessdata.projectnaptha.com/4.0.0_fast" },
      { lang: "ind", path: "https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0_fast" },
      { lang: "eng", path: "https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0_fast" },
      { lang: "eng", path: "https://tessdata.projectnaptha.com/4.0.0_fast" }
    ];

    let lastErr = null;
    for (const attempt of attempts) {
      try {
        const worker = await tesseract.createWorker(attempt.lang, 1, {
          langPath: attempt.path,
          logger: (m) => {
            if (typeof onProgress === "function" && m.status === "recognizing text") {
              onProgress(Math.round((m.progress || 0) * 100));
            }
          }
        });
        receiptOcrWorker = worker;
        return worker;
      } catch (err) {
        console.warn(`Worker init failed (${attempt.lang} at ${attempt.path}):`, err);
        lastErr = err;
      }
    }
    throw lastErr || new Error("Gagal mengaktifkan pembaca nota.");
  })();

  try {
    return await receiptWorkerInitPromise;
  } catch (err) {
    receiptWorkerInitPromise = null;
    throw err;
  }
}

function preloadReceiptOcr() {
  if (receiptOcrWorker || receiptWorkerInitPromise) return;
  if (!window.Tesseract) {
    loadTesseract()
      .then(() => setTimeout(() => getReceiptWorker().catch(() => {}), 400))
      .catch(() => {});
  } else {
    setTimeout(() => getReceiptWorker().catch(() => {}), 300);
  }
}

async function runOcrOnCurrentReceipt() {
  if (!currentOcrCanvas && !receiptImage) return;
  const imageSource = currentOcrCanvas || receiptImage;

  const pill = document.getElementById("receipt-status-pill");
  const icon = document.getElementById("receipt-status-icon");
  const text = document.getElementById("receipt-status-text");
  const statusNote = document.getElementById("receipt-status");
  const laser = document.getElementById("receipt-scan-laser");
  const progBar = document.getElementById("receipt-progress-bar");
  const progFill = document.getElementById("receipt-progress-fill");
  const scanBtn = document.getElementById("scan-receipt");

  if (laser) laser.hidden = false;
  if (progBar) progBar.hidden = false;
  if (progFill) progFill.style.width = "10%";
  if (scanBtn) {
    scanBtn.hidden = false;
    scanBtn.disabled = true;
    scanBtn.textContent = "Sedang membaca...";
  }

  if (pill) {
    pill.className = "receipt-status-pill status-scanning";
    if (icon) icon.textContent = "⚡";
    if (text) text.textContent = "Membaca nota otomatis...";
  }
  if (statusNote) statusNote.textContent = "Menganalisis teks nota dan mencari nominal total...";

  try {
    const worker = await getReceiptWorker((pct) => {
      if (progFill) progFill.style.width = `${Math.max(15, pct)}%`;
      if (text) text.textContent = `Membaca nota... ${pct}%`;
    });

    if (progFill) progFill.style.width = "90%";
    const result = await worker.recognize(imageSource);
    const parsed = findReceiptData(result && result.data && result.data.text);

    if (parsed.amount) {
      document.getElementById("transaction-amount").value = parsed.amount;

      const amountWrap = document.getElementById("price-input-wrapper");
      if (amountWrap) {
        amountWrap.classList.remove("highlight-pulse");
        void amountWrap.offsetWidth;
        amountWrap.classList.add("highlight-pulse");
      }

      const descInput = document.getElementById("transaction-description");
      if (descInput && !descInput.value.trim()) {
        descInput.value = parsed.merchant ? `Belanja - ${parsed.merchant}` : "Belanja dari nota";
      }

      if (pill) {
        pill.className = "receipt-status-pill status-success";
        if (icon) icon.textContent = "✅";
        if (text) text.textContent = `Total: ${currency.format(parsed.amount)}`;
      }
      if (statusNote) {
        statusNote.textContent = `Nominal ${currency.format(parsed.amount)} terisi otomatis. Periksa kembali sebelum menyimpan.`;
      }
      showToast(`✅ Berhasil membaca total: ${currency.format(parsed.amount)}`);
    } else {
      if (pill) {
        pill.className = "receipt-status-pill status-warning";
        if (icon) icon.textContent = "⚠️";
        if (text) text.textContent = "Total belum terdeteksi";
      }
      if (statusNote) {
        statusNote.textContent = "Nominal tidak terbaca jelas. Ketik jumlah secara manual di kolom Jumlah di atas.";
      }
      showToast("Total nota tidak terdeteksi. Silakan ketik jumlah secara manual.", true);
      document.getElementById("transaction-amount").focus();
    }
  } catch (error) {
    console.error("Gagal membaca nota:", error);
    if (pill) {
      pill.className = "receipt-status-pill status-warning";
      if (icon) icon.textContent = "⚠️";
      if (text) text.textContent = "Gagal membaca nota";
    }
    if (statusNote) {
      statusNote.textContent = error.message || "Gagal membaca nota. Silakan isi jumlah secara manual.";
    }
    showToast(error.message || "Nota gagal dibaca. Ketik jumlah secara manual.", true);
  } finally {
    if (laser) laser.hidden = true;
    if (progBar) progBar.hidden = true;
    if (scanBtn) {
      scanBtn.hidden = false;
      scanBtn.disabled = false;
      scanBtn.textContent = "🔄 Pindai ulang";
    }
  }
}

async function processAndScanReceipt(file) {
  const previewWrap = document.getElementById("receipt-preview-wrap");
  const preview = document.getElementById("receipt-preview");
  const pill = document.getElementById("receipt-status-pill");
  const icon = document.getElementById("receipt-status-icon");
  const text = document.getElementById("receipt-status-text");
  const statusNote = document.getElementById("receipt-status");
  const removeBtn = document.getElementById("remove-receipt");

  if (previewWrap) previewWrap.hidden = false;
  if (removeBtn) removeBtn.hidden = false;
  if (pill) {
    pill.className = "receipt-status-pill status-scanning";
    if (icon) icon.textContent = "⏳";
    if (text) text.textContent = "Menyiapkan foto...";
  }
  if (statusNote) statusNote.textContent = "Memproses resolusi dan ketajaman foto nota...";

  try {
    const { storageDataUrl, ocrCanvas } = await prepareReceiptImages(file);
    receiptImage = storageDataUrl;
    currentOcrCanvas = ocrCanvas;

    if (preview) {
      preview.src = storageDataUrl;
    }

    // Jalankan auto-baca langsung tanpa perlu klik tombol lagi!
    await runOcrOnCurrentReceipt();
  } catch (err) {
    console.error("Gagal memproses foto nota:", err);
    resetReceiptPreview();
    receiptImage = null;
    currentOcrCanvas = null;
    showToast(err.message || "Foto nota tidak dapat diproses.", true);
  }
}

function openReceiptFromEvent(event) {
  const button = event.target.closest("[data-view-receipt]");
  if (!button) return;
  const transaction = state.transactions.find((item) => item.id === button.dataset.viewReceipt);
  if (!transaction?.receiptImage) return;
  document.getElementById("receipt-view-image").src = transaction.receiptImage;
  document.getElementById("receipt-dialog").showModal();
}

function renderSaleCart() {
  const rows = document.getElementById("sale-cart-rows");
  rows.innerHTML = saleCart.map((item) => `<tr>
    <td>${escapeHTML(item.name)}<small class="sale-unit-price">${currency.format(item.unitPrice)} / buah</small></td>
    <td>${item.quantity.toLocaleString("id-ID")}</td>
    <td class="align-right">${currency.format(item.unitPrice * item.quantity)}</td>
    <td class="align-right sale-item-actions"><button class="sale-quantity-decrease" type="button" data-decrease-sale-item="${escapeHTML(item.productId)}" aria-label="Kurangi jumlah ${escapeHTML(item.name)}">−</button><button class="product-delete" type="button" data-remove-sale-item="${escapeHTML(item.productId)}" aria-label="Hapus ${escapeHTML(item.name)} dari penjualan">×</button></td>
  </tr>`).join("");
  document.getElementById("sale-cart-empty").hidden = saleCart.length > 0;
  document.querySelector(".sale-cart-table").hidden = saleCart.length === 0;
  document.getElementById("sale-total").textContent = currency.format(saleCart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0));
}

function resetProductForm() {
  const form = document.getElementById("product-form");
  form.reset();
  editingProductId = null;
  document.getElementById("product-form-title").textContent = "Tambah barang";
  document.getElementById("product-form-description").textContent = "Atur modal dan harga jual barang.";
  document.getElementById("product-submit").innerHTML = 'Simpan barang <span>→</span>';
  document.getElementById("cancel-product-edit").hidden = true;
}

document.getElementById("today-label").textContent = formatDate(today, fullDateFormatter);
document.getElementById("dashboard-date").value = today;
document.getElementById("report-month").value = today.slice(0, 7);
document.getElementById("transaction-date-filter").value = today.slice(0, 7);
renderAll();

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${button.dataset.view}`));
  const labelEl = button.querySelector(".nav-label-text");
  document.getElementById("page-crumb").textContent = (labelEl ? labelEl.textContent : button.textContent.replace(/^[⌂▤↕▥]\s*/, "")).trim();
  window.scrollTo({ top: 0, behavior: "auto" });
}));

document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => {
  document.querySelector(`.nav-item[data-view="${button.dataset.go}"]`).click();
}));

document.querySelectorAll("[data-open-transaction]").forEach((button) => button.addEventListener("click", () => openTransaction(button.dataset.type)));

document.querySelectorAll(".period-option").forEach((button) => button.addEventListener("click", () => {
  const previousValue = document.getElementById("dashboard-date").value;
  dashboardPeriod = button.dataset.period;
  document.querySelectorAll(".period-option").forEach((item) => item.classList.toggle("active", item === button));
  const dateInput = document.getElementById("dashboard-date");
  dateInput.type = dashboardPeriod === "day" ? "date" : "month";
  dateInput.value = dashboardPeriod === "day" ? (previousValue.length === 7 ? `${previousValue}-${today.slice(8, 10)}` : previousValue) : previousValue.slice(0, 7);
  renderDashboard();
}));

document.getElementById("dashboard-date").addEventListener("change", renderDashboard);
document.getElementById("report-month").addEventListener("change", renderReport);
const printReportBtn = document.getElementById("print-report-button");
if (printReportBtn) {
  printReportBtn.addEventListener("click", () => {
    prepareReportPrint();
    window.print();
  });
}
window.addEventListener("beforeprint", prepareReportPrint);

const bukuKasRows = document.getElementById("buku-kas-rows");
if (bukuKasRows) bukuKasRows.addEventListener("click", openReceiptFromEvent);
document.getElementById("product-search").addEventListener("input", renderProducts);
document.getElementById("transaction-filter").addEventListener("change", renderTransactions);
document.getElementById("transaction-date-filter").addEventListener("change", renderTransactions);

document.getElementById("product-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const name = form.elements.name.value.trim();
  const buyPrice = Number(form.elements.buyPrice.value);
  const sellingPrice = Number(form.elements.sellingPrice.value);
  if (!name || !Number.isSafeInteger(buyPrice) || buyPrice < 0 || !Number.isSafeInteger(sellingPrice) || sellingPrice < 1) {
    showToast("Isi nama barang, harga beli, dan harga jual dengan benar.", true);
    return;
  }
  let originalProduct;
  if (editingProductId) {
    const index = state.products.findIndex((item) => item.id === editingProductId);
    if (index < 0) {
      resetProductForm();
      showToast("Barang tidak ditemukan. Silakan muat ulang daftar barang.", true);
      return;
    }
    originalProduct = state.products[index];
    state.products[index] = { ...originalProduct, name, buyPrice, sellingPrice };
  } else {
    state.products.push({ id: crypto.randomUUID(), name, buyPrice, sellingPrice, createdAt: new Date().toISOString() });
  }
  if (!persistState()) {
    if (editingProductId) {
      const index = state.products.findIndex((item) => item.id === editingProductId);
      if (index >= 0) state.products[index] = originalProduct;
    } else {
      state.products.pop();
    }
    return;
  }
  const wasEditing = Boolean(editingProductId);
  resetProductForm();
  renderProducts();
  showToast(wasEditing ? "Perubahan barang berhasil disimpan." : "Barang berhasil disimpan.");
});

document.getElementById("product-rows").addEventListener("click", (event) => {
  const sellButton = event.target.closest("[data-product-id]");
  const editButton = event.target.closest("[data-edit-product]");
  const deleteButton = event.target.closest("[data-delete-product]");
  if (editButton) {
    const product = state.products.find((item) => item.id === editButton.dataset.editProduct);
    if (!product) return;
    editingProductId = product.id;
    const form = document.getElementById("product-form");
    form.elements.name.value = product.name;
    form.elements.buyPrice.value = product.buyPrice ?? "";
    form.elements.sellingPrice.value = product.sellingPrice;
    document.getElementById("product-form-title").textContent = "Ubah barang";
    document.getElementById("product-form-description").textContent = "Perbarui modal atau harga jual barang.";
    document.getElementById("product-submit").innerHTML = 'Simpan perubahan <span>→</span>';
    document.getElementById("cancel-product-edit").hidden = false;
    form.elements.name.focus();
  }
  if (sellButton) {
    const product = state.products.find((item) => item.id === sellButton.dataset.productId);
    if (!product) return;
    openTransaction("income");
    document.getElementById("sale-product-select").value = product.id;
    document.getElementById("sale-quantity").value = "1";
    document.getElementById("add-sale-item").click();
  }
  if (deleteButton) {
    const index = state.products.findIndex((item) => item.id === deleteButton.dataset.deleteProduct);
    if (index < 0) return;
    const [removed] = state.products.splice(index, 1);
    if (!persistState()) {
      state.products.splice(index, 0, removed);
      return;
    }
    renderProducts();
    showToast("Barang dihapus dari katalog.");
  }
});

document.getElementById("transaction-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const isSale = form.elements.type.value === "income" && form.elements.incomeMode.value === "sale";
  const amount = isSale
    ? saleCart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
    : Number(form.elements.amount.value);
  const description = isSale
    ? `Penjualan: ${saleCart.map((item) => `${item.name} x${item.quantity}`).join(", ")}`
    : form.elements.description.value.trim();
  if (!description || !Number.isSafeInteger(amount) || amount < 1 || !form.elements.date.value || (isSale && saleCart.length === 0)) {
    showToast(isSale ? "Pilih minimal satu barang untuk dicatat sebagai penjualan." : "Lengkapi keterangan, jumlah, dan tanggal dengan benar.", true);
    return;
  }
  const transaction = {
    id: crypto.randomUUID(),
    type: form.elements.type.value,
    description,
    amount,
    date: form.elements.date.value,
    createdAt: new Date().toISOString(),
    ...(form.elements.type.value === "expense" && receiptImage ? { receiptImage } : {}),
    ...(isSale ? { items: saleCart.map((item) => ({ ...item })) } : {})
  };
  state.transactions.push(transaction);
  if (!persistState()) {
    state.transactions.pop();
    return;
  }
  document.getElementById("transaction-dialog").close();
  renderAll();
  showToast("Transaksi berhasil dicatat.");
});

document.getElementById("close-dialog").addEventListener("click", () => document.getElementById("transaction-dialog").close());
document.getElementById("cancel-dialog").addEventListener("click", () => document.getElementById("transaction-dialog").close());
document.getElementById("cancel-product-edit").addEventListener("click", resetProductForm);
document.getElementById("sync-settings-button").addEventListener("click", () => {
  document.getElementById("google-client-id").value = syncConfig?.clientId || "";
  document.getElementById("google-sheet-id").value = syncConfig?.spreadsheetId || "";
  setSyncStatus(googleAccessToken ? "Terhubung ke Google Sheets." : syncConfig ? "Pengaturan tersimpan; login Google untuk menyinkronkan." : "Belum terhubung.");
  document.getElementById("sync-dialog").showModal();
});
document.getElementById("sync-settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  saveSyncConfig();
});
document.getElementById("sync-connect").addEventListener("click", connectGoogleSheets);
document.getElementById("sync-upload").addEventListener("click", uploadToGoogleSheets);
document.getElementById("sync-download").addEventListener("click", downloadFromGoogleSheets);
document.getElementById("export-data").addEventListener("click", exportLocalBackup);
document.getElementById("import-data").addEventListener("change", (event) => {
  importLocalBackup(event.currentTarget.files[0]);
  event.currentTarget.value = "";
});
document.getElementById("close-sync-dialog").addEventListener("click", () => document.getElementById("sync-dialog").close());
document.getElementById("transaction-type").addEventListener("change", updateTransactionMode);
document.getElementById("income-mode").addEventListener("change", updateTransactionMode);
const btnCamera = document.getElementById("btn-camera-receipt");
if (btnCamera) {
  btnCamera.addEventListener("click", () => document.getElementById("receipt-camera").click());
}

const btnFile = document.getElementById("btn-file-receipt");
if (btnFile) {
  btnFile.addEventListener("click", () => document.getElementById("receipt-file").click());
}

const handleReceiptFileChange = async (event) => {
  const file = event.currentTarget.files && event.currentTarget.files[0];
  event.currentTarget.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/") || file.size > 20 * 1024 * 1024) {
    showToast("Pilih foto nota yang valid (maksimal 20 MB).", true);
    return;
  }
  await processAndScanReceipt(file);
};

const cameraInput = document.getElementById("receipt-camera");
if (cameraInput) cameraInput.addEventListener("change", handleReceiptFileChange);

const fileInput = document.getElementById("receipt-file");
if (fileInput) fileInput.addEventListener("change", handleReceiptFileChange);

document.getElementById("remove-receipt").addEventListener("click", () => {
  receiptImage = null;
  currentOcrCanvas = null;
  resetReceiptPreview();
  showToast("Foto nota dihapus.");
});

document.getElementById("scan-receipt").addEventListener("click", () => {
  if (currentOcrCanvas || receiptImage) {
    runOcrOnCurrentReceipt();
  } else {
    document.getElementById("receipt-camera").click();
  }
});
document.getElementById("transaction-rows").addEventListener("click", openReceiptFromEvent);
document.getElementById("recent-transactions").addEventListener("click", openReceiptFromEvent);
document.getElementById("close-receipt-dialog").addEventListener("click", () => document.getElementById("receipt-dialog").close());
document.getElementById("add-sale-item").addEventListener("click", () => {
  const product = state.products.find((item) => item.id === document.getElementById("sale-product-select").value);
  const quantity = Number(document.getElementById("sale-quantity").value);
  if (!product || !Number.isSafeInteger(quantity) || quantity < 1) {
    showToast("Pilih barang dan masukkan jumlah minimal 1.", true);
    return;
  }
  const existing = saleCart.find((item) => item.productId === product.id);
  const combinedQuantity = (existing?.quantity || 0) + quantity;
  if (!Number.isSafeInteger(combinedQuantity) || !Number.isSafeInteger(combinedQuantity * product.sellingPrice)) {
    showToast("Jumlah barang melebihi batas yang dapat dihitung.", true);
    return;
  }
  if (existing) {
    existing.quantity = combinedQuantity;
  } else {
    saleCart.push({
      productId: product.id,
      name: product.name,
      quantity,
      unitPrice: product.sellingPrice,
      buyPrice: product.buyPrice
    });
  }
  const total = saleCart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  if (!Number.isSafeInteger(total)) {
    if (existing) existing.quantity -= quantity;
    else saleCart.pop();
    showToast("Total penjualan melebihi batas yang dapat dihitung.", true);
    return;
  }
  document.getElementById("sale-quantity").value = "1";
  renderSaleCart();
});
document.getElementById("sale-cart-rows").addEventListener("click", (event) => {
  const decreaseButton = event.target.closest("[data-decrease-sale-item]");
  const removeButton = event.target.closest("[data-remove-sale-item]");
  if (decreaseButton) {
    const item = saleCart.find((entry) => entry.productId === decreaseButton.dataset.decreaseSaleItem);
    if (!item) return;
    item.quantity -= 1;
    if (item.quantity === 0) {
      saleCart = saleCart.filter((entry) => entry.productId !== item.productId);
    }
    renderSaleCart();
    return;
  }
  if (!removeButton) return;
  saleCart = saleCart.filter((item) => item.productId !== removeButton.dataset.removeSaleItem);
  renderSaleCart();
});
