import { PRODUCT_FIELDS, createDefaultConfig, slugifyDomain } from "../lib/schema.js";
import { createBridgeClient } from "../lib/bridge-client.js";
import { loadBridgeSettings, loadConfig, saveBridgeSettings, saveConfig, loadOpenAiSettings, saveOpenAiSettings } from "../lib/storage.js";
import { productsToAdapterRows, rowsToCsv, rowsToJsonBlob, rowsToXlsxBlob } from "../lib/export.js";
import { generateAdapterRows } from "../lib/openai-client.js";
import { formatScanProgress } from "../lib/crawler.js";
import * as fsdir from "../lib/fsdir.js";

const FIELD_LABELS = {
  product_name: "Nazwa",
  sku: "SKU",
  ean: "EAN/GTIN",
  brand: "Marka",
  price: "Cena",
  old_price: "Cena stara",
  currency: "Waluta",
  availability: "Dostępność",
  category: "Kategoria",
  description: "Opis",
  images: "Zdjęcia",
  product_url: "URL produktu",
  variants: "Warianty",
};

const el = (id) => document.getElementById(id);

const JOB_DONE_STATUSES = new Set(["completed", "failed", "cancelled", "timeout"]);
const JOB_STATUS_LABELS = {
  queued: "W kolejce",
  preparing_workspace: "Przygotowanie",
  generating_adapter: "Generowanie adaptera",
  running_scraper: "Scrapowanie",
  uploading_outputs: "Zapisywanie",
  completed: "Gotowe",
  failed: "Błąd",
  cancelled: "Anulowano",
  timeout: "Timeout",
};

/** @type {{tabId:number, domain:string, url:string, config: import('../lib/schema.js').ScraperConfig, projectId: string|null, scanning: boolean, scanProducts: any[], adapterRows: any[]|null, outputDirHandle: any, openai: {apiKey:string, model:string}, bridge: {mode:string, baseUrl:string, localBaseUrl:string, cloudBaseUrl:string, cloudUserId:string, connected:boolean, jobId:string|null}}} */
const state = {
  tabId: null,
  domain: "",
  url: "",
  config: null,
  projectId: null,
  scanning: false,
  scanProducts: [],
  adapterRows: null,
  outputDirHandle: null,
  openai: { apiKey: "", model: "" },
  bridge: {
    mode: "local",
    baseUrl: "http://127.0.0.1:8765",
    localBaseUrl: "http://127.0.0.1:8765",
    cloudBaseUrl: "http://127.0.0.1:8766",
    cloudUserId: "dev-user",
    connected: false,
    jobId: null,
  },
};

function log(message) {
  const box = el("log-output");
  const ts = new Date().toLocaleTimeString();
  box.textContent = `[${ts}] ${message}\n` + box.textContent;
}

function toast(message, kind = "ok") {
  const box = el("toast");
  box.textContent = message;
  box.className = `toast ${kind}`;
  box.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { box.hidden = true; }, 3500);
}

function normalizeImageDomainTemplate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes("[sku]") || raw.includes("[rozszerzenie]")) return raw;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const clean = withProtocol.replace(/\/+$/, "");
  return `${clean}/produkty/[sku].[rozszerzenie]`;
}

function setExportButtonsDisabled(disabled) {
  for (const id of ["export-excel-btn", "export-csv-btn", "export-json-preview-btn", "export-images-btn"]) {
    el(id).disabled = disabled;
  }
}

function isCloudMode() {
  return state.bridge.mode === "cloud";
}

function frameworkLabel() {
  return isCloudMode() ? "Cloud" : "Framework";
}

function isAiAvailable() {
  return isCloudMode() || !!state.openai.apiKey;
}

function currentAiLabel() {
  return isCloudMode() ? "backend wybiera model" : state.openai.model || "gpt-5.6-sol";
}

function currentFrameworkBaseUrl() {
  if (isCloudMode()) return state.bridge.cloudBaseUrl || "http://127.0.0.1:8766";
  return state.bridge.localBaseUrl || state.bridge.baseUrl || "http://127.0.0.1:8765";
}

function currentFrameworkHeaders() {
  return isCloudMode() ? { "X-Shark-User-Id": state.bridge.cloudUserId || "dev-user" } : {};
}

function bridgeClient() {
  return createBridgeClient(currentFrameworkBaseUrl(), fetch, {
    headers: currentFrameworkHeaders(),
    serviceName: isCloudMode() ? "cloud API" : "bridgem",
  });
}

function setBridgeStatus(text, kind = "idle") {
  const label = el("bridge-status-label");
  label.textContent = text;
  label.dataset.kind = kind;
}

function imageColumnsFromFallbackRows(fallbackRows) {
  return fallbackRows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => /^zdj\d+$/i.test(key))));
}

function mergeAiRowsWithImages(fallbackRows, aiRows) {
  const imageColumns = imageColumnsFromFallbackRows(fallbackRows);
  return fallbackRows.map((fallback, index) => {
    const ai = (aiRows || []).find((row) => Number(row.index) === index) || aiRows?.[index] || {};
    const cleanAi = { ...ai };
    delete cleanAi.index;
    return { ...fallback, ...cleanAi, ...imageColumns[index] };
  });
}

async function generateAiRowsInBatches(products, batchSize = 8) {
  const rows = [];
  const cloudClient = isCloudMode() ? bridgeClient() : null;
  let model = "";
  for (let offset = 0; offset < products.length; offset += batchSize) {
    const batch = products.slice(offset, offset + batchSize);
    el("scan-progress-wrap").hidden = false;
    el("scan-progress-text").textContent = `AI generuje dane: ${Math.min(offset + batch.length, products.length)}/${products.length} produktów`;
    const res = cloudClient
      ? await cloudClient.normalizeProducts({ products: batch, model: state.openai.model || "" })
      : await generateAdapterRows({
          apiKey: state.openai.apiKey,
          model: state.openai.model,
          products: batch,
        });
    model = res.model || model;
    for (const row of res.rows || []) {
      const localIndex = Number(row.index);
      rows.push({ ...row, index: Number.isFinite(localIndex) ? localIndex + offset : rows.length });
    }
  }
  return { rows, model };
}

// --- komunikacja z aktywną kartą -------------------------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    // Content script mógł nie zdążyć się wstrzyknąć (np. strona otwarta przed instalacją).
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/detector.js", "content/picker.js"] });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

// --- render pól produktowych -----------------------------------------------------

function fieldValuePreview(spec) {
  if (!spec) return "";
  const v = spec.value;
  if (v === undefined || v === null) return "";
  const text = String(v);
  return text.length > 60 ? text.slice(0, 60) + "…" : text;
}

function renderFields() {
  const container = el("fields-list");
  container.innerHTML = "";
  for (const field of PRODUCT_FIELDS) {
    const spec = state.config.fields[field];
    const row = document.createElement("div");
    row.className = "field-item" + (spec ? "" : " missing");

    const name = document.createElement("div");
    name.className = "fname";
    name.textContent = FIELD_LABELS[field] || field;

    const valueBox = document.createElement("div");
    const badge = document.createElement("span");
    badge.className = "badge " + (spec ? spec.source : "missing");
    badge.textContent = spec ? spec.source : "brak";
    const valueSpan = document.createElement("div");
    valueSpan.className = "fvalue";
    valueSpan.textContent = fieldValuePreview(spec) || "— nie wykryto —";
    valueBox.appendChild(badge);
    valueBox.appendChild(valueSpan);

    const pickBtn = document.createElement("button");
    pickBtn.className = "btn pick-btn";
    pickBtn.textContent = "Wskaż element";
    pickBtn.dataset.field = field;

    row.appendChild(name);
    row.appendChild(valueBox);
    row.appendChild(pickBtn);
    container.appendChild(row);
  }
}

// --- render reszty formularza z configu -------------------------------------------

function renderForm() {
  const c = state.config;
  el("domain-label").textContent = c.domain;
  el("start-url-label").textContent = c.start_url;

  el("mode-select").value = c.mode;
  el("source-name-input").value = c.source.name;
  el("base-url-input").value = c.source.base_url;
  el("start-url-input").value = c.start_url;

  el("item-selector-input").value = c.list_page.item_selector || "";
  el("url-selector-input").value = c.list_page.url_selector || "";
  el("url-attr-input").value = c.list_page.url_attribute || "href";
  el("pagination-mode-select").value = c.list_page.pagination.mode;
  el("next-selector-input").value = c.list_page.pagination.next_selector || "";
  el("load-more-selector-input").value = c.list_page.pagination.load_more_selector || "";
  el("max-pages-input").value = c.list_page.pagination.max_pages || 50;

  el("image-base-url-input").value = c.image_links.public_base_url || "";
  el("image-brand-input").value = c.image_links.brand_segment || "";
  el("notes-textarea").value = c.notes || "";

  renderFields();
}

/** Czyta wartości z formularza (poza fields — te aktualizowane są przez detect/picker/scan) do state.config. */
function readFormIntoConfig() {
  const c = state.config;
  c.mode = el("mode-select").value;
  c.source.name = slugifyDomain(el("source-name-input").value || c.domain);
  c.source.base_url = el("base-url-input").value.trim();
  c.start_url = el("start-url-input").value.trim();

  c.list_page.item_selector = el("item-selector-input").value.trim();
  c.list_page.url_selector = el("url-selector-input").value.trim();
  c.list_page.url_attribute = el("url-attr-input").value.trim() || "href";
  c.list_page.enabled = !!c.list_page.item_selector;

  const pMode = el("pagination-mode-select").value;
  c.list_page.pagination = {
    mode: pMode,
    next_selector: el("next-selector-input").value.trim(),
    load_more_selector: el("load-more-selector-input").value.trim(),
    max_pages: Number(el("max-pages-input").value) || 50,
    experimental: pMode === "load_more" || pMode === "infinite_scroll",
  };

  c.image_links.public_base_url = normalizeImageDomainTemplate(el("image-base-url-input").value);
  c.image_links.brand_segment = "";
  c.notes = el("notes-textarea").value;
  return c;
}

// --- akcje: detekcja pojedyncza / listing (ręczne, w sekcji "Szczegóły") -----------

async function onDetectProduct() {
  el("detect-btn").disabled = true;
  try {
    const result = await sendToTab(state.tabId, { action: "DETECT_PRODUCT" });
    if (result?.error) throw new Error(result.error);
    for (const [field, spec] of Object.entries(result.fields)) {
      const existing = state.config.fields[field];
      if (existing && existing.source === "css") continue; // nie nadpisuj ręcznych wyborów
      state.config.fields[field] = spec;
    }
    renderFields();
    const sources = Object.entries(result.detectedFrom).filter(([, v]) => v).map(([k]) => k);
    log(`Detekcja zakończona. Źródła: ${sources.join(", ") || "brak"}. Pól wykrytych: ${Object.keys(result.fields).length}/${PRODUCT_FIELDS.length}.`);
    toast("Detekcja zakończona");
  } catch (err) {
    toast(String(err.message || err), "err");
    log(`Błąd detekcji: ${err.message || err}`);
  } finally {
    el("detect-btn").disabled = false;
  }
}

async function onPickField(field) {
  toast(`Kliknij element na stronie dla pola "${FIELD_LABELS[field] || field}" (Esc = anuluj)`);
  await sendToTab(state.tabId, { action: "START_PICKER", field });
}

function onPickerMessage(message) {
  if (message?.action === "PICKER_RESULT") {
    state.config.fields[message.field] = {
      source: "css",
      selector: message.selector,
      attr: message.attr,
      multiple: false,
      value: message.value,
    };
    renderFields();
    toast(`Przypisano selektor dla "${FIELD_LABELS[message.field] || message.field}"`);
  } else if (message?.action === "PICKER_CANCELLED") {
    toast("Wybór elementu anulowany", "err");
  } else if (message?.action === "SCAN_PROGRESS") {
    onScanProgress(message);
  } else if (message?.action === "SCAN_PRODUCT") {
    onScanProduct(message.product);
  }
}

async function onDetectListing() {
  el("detect-listing-btn").disabled = true;
  try {
    const listing = await sendToTab(state.tabId, { action: "DETECT_LISTING" });
    const pagination = await sendToTab(state.tabId, { action: "DETECT_PAGINATION" });
    if (listing?.error) throw new Error(listing.error);

    el("item-selector-input").value = listing.item_selector || "";
    el("url-selector-input").value = listing.url_selector || "";
    el("url-attr-input").value = listing.url_attribute || "href";
    el("listing-summary").textContent = listing.found
      ? `Znaleziono ${listing.detected_count} kart produktowych. Przykład: ${(listing.sample_urls || [])[0] || "—"}`
      : "Nie wykryto powtarzalnej listy produktów — wskaż selektor ręcznie.";

    if (pagination && !pagination.error) {
      el("pagination-mode-select").value = pagination.mode;
      el("next-selector-input").value = pagination.next_selector || "";
      el("load-more-selector-input").value = pagination.load_more_selector || "";
    }
    log(`Wykrywanie listy: ${listing.found ? "OK" : "brak wyniku"}, paginacja: ${pagination?.mode ?? "?"}.`);
  } catch (err) {
    toast(String(err.message || err), "err");
    log(`Błąd detekcji listy: ${err.message || err}`);
  } finally {
    el("detect-listing-btn").disabled = false;
  }
}

// --- auto-skan całego katalogu (przycisk hero "Skanuj sklep") ----------------------

function fieldText(fields, name) {
  const v = fields?.[name]?.value;
  return v === undefined || v === null || v === "" ? "" : String(v);
}

function appendResultRow(product) {
  const tbody = el("results-tbody");
  const tr = document.createElement("tr");
  if (product.ok === false) tr.className = "row-error";

  const name = fieldText(product.fields, "product_name") || "—";
  const sku = fieldText(product.fields, "sku") || "—";
  const price = fieldText(product.fields, "price") || "—";
  const hasImages = fieldText(product.fields, "images") ? "✓" : "—";
  const status = product.ok === false ? `błąd: ${product.error || "?"}` : "ok";

  const cells = [name, sku, price, hasImages, status];
  for (const text of cells) {
    const td = document.createElement("td");
    td.textContent = text;
    td.title = text;
    tr.appendChild(td);
  }
  const urlTd = document.createElement("td");
  urlTd.className = "col-url";
  const a = document.createElement("a");
  a.href = product.url;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = product.url;
  urlTd.appendChild(a);
  tr.appendChild(urlTd);

  tbody.appendChild(tr);
}

function onScanProduct(product) {
  state.scanProducts.push(product);
  appendResultRow(product);
  el("results-count").textContent = String(state.scanProducts.length);
  el("results-card").hidden = false;
}

function onScanProgress(message) {
  const wrap = el("scan-progress-wrap");
  wrap.hidden = false;
  const text = formatScanProgress({
    pagesVisited: message.pagesVisited || 0,
    pagesTotal: message.pagesTotal || 0,
    productsFound: message.productsFound || 0,
    productsTotal: message.productsTotal || 0,
  });
  const phaseLabel = message.phase === "listing" ? "Zbieranie listy produktów" : "Pobieranie produktów";
  el("scan-progress-text").textContent = `${phaseLabel}: ${text}`;

  const fill = el("scan-progress-fill");
  if (message.phase === "products" && message.productsTotal) {
    fill.style.width = `${Math.min(100, Math.round((message.productsFound / message.productsTotal) * 100))}%`;
  } else if (message.phase === "listing" && message.pagesTotal) {
    fill.style.width = `${Math.min(100, Math.round((message.pagesVisited / message.pagesTotal) * 100))}%`;
  }
}

function renderWarnings(warnings) {
  const list = el("scan-warnings");
  list.innerHTML = "";
  if (!warnings || warnings.length === 0) {
    list.hidden = true;
    return;
  }
  for (const w of warnings) {
    const li = document.createElement("li");
    li.textContent = w;
    list.appendChild(li);
  }
  list.hidden = false;
}

async function onScanCatalog() {
  await saveBridgeSettingsFromForm({ resetJob: false });
  await onApiKeyInputChange();
  readFormIntoConfig();
  state.scanning = true;
  state.scanProducts = [];
  state.adapterRows = null;
  el("results-tbody").innerHTML = "";
  el("results-count").textContent = "0";
  el("results-card").hidden = true;
  renderWarnings([]);

  el("scan-btn").disabled = true;
  setExportButtonsDisabled(true);
  el("stop-scan-btn").hidden = false;
  el("scan-progress-wrap").hidden = false;
  el("scan-progress-fill").style.width = "0%";
  el("scan-progress-text").textContent = "Wykrywanie listy i pól produktowych…";

  try {
    const maxPages = Number(el("max-pages-input").value) || 50;
    const maxProducts = Number(el("max-products-input").value) || 500;
    const useAI = el("use-ai-checkbox").checked;
    const cloudAi = isCloudMode()
      ? { baseUrl: currentFrameworkBaseUrl(), headers: currentFrameworkHeaders() }
      : null;
    const result = await sendToTab(state.tabId, {
      action: "SCAN_CATALOG",
      options: {
        maxPages,
        maxProducts,
        useAI,
        apiKey: isCloudMode() ? "" : state.openai.apiKey,
        aiModel: state.openai.model,
        aiProvider: isCloudMode() ? "cloud" : "openai",
        cloudAi,
      },
    });
    if (result?.error) throw new Error(result.error);

    // Wypełniamy resztę formularza tym, co auto-skan wykrył — do ewentualnej ręcznej korekty.
    if (result.listing?.found) {
      el("item-selector-input").value = result.listing.item_selector || "";
      el("url-selector-input").value = result.listing.url_selector || "";
      el("url-attr-input").value = result.listing.url_attribute || "href";
      el("listing-summary").textContent = `Znaleziono ${result.listing.detected_count} kart produktowych.`;
    }
    if (result.pagination) {
      el("pagination-mode-select").value = result.pagination.mode;
      el("next-selector-input").value = result.pagination.next_selector || "";
      el("load-more-selector-input").value = result.pagination.load_more_selector || "";
    }
    if (result.fieldMap && Object.keys(result.fieldMap).length > 0) {
      for (const [field, spec] of Object.entries(result.fieldMap)) {
        const existing = state.config.fields[field];
        if (existing && existing.source === "css") continue;
        state.config.fields[field] = spec;
      }
      renderFields();
    }
    if (result.guessedMode) {
      el("mode-select").value = result.guessedMode;
      state.config.mode = result.guessedMode;
    }

    renderWarnings(result.warnings);
    el("results-count").textContent = String(state.scanProducts.length);
    el("results-card").hidden = state.scanProducts.length === 0;

    const okCount = state.scanProducts.filter((p) => p.ok !== false).length;
    el("scan-progress-text").textContent = result.stopped
      ? `Zatrzymano ręcznie. Zebrano ${okCount}/${state.scanProducts.length} produktów.`
      : `Zakończono. Zebrano ${okCount}/${state.scanProducts.length} produktów, ${result.pagesVisited || 1} stron.`;
    log(`Auto-skan zakończony (${result.mode}): ${state.scanProducts.length} produktów, ${result.pagesVisited || 1} stron, tryb=${result.guessedMode || state.config.mode}.`);
    toast(result.stopped ? "Skan zatrzymany" : "Skan zakończony");
  } catch (err) {
    toast(String(err.message || err), "err");
    log(`Błąd auto-skanu: ${err.message || err}`);
  } finally {
    state.scanning = false;
    el("scan-btn").disabled = false;
    setExportButtonsDisabled(false);
    el("stop-scan-btn").hidden = true;
  }
}

async function onStopScan() {
  await sendToTab(state.tabId, { action: "STOP_SCAN" });
  toast("Zatrzymywanie skanu…");
}

function toastError(err) {
  if (err?.name === "AbortError") {
    toast("Anulowano wybór folderu");
    return;
  }
  toast(String(err?.message || err), "err");
  log(`Błąd: ${err?.message || err}`);
}

function updateFolderLabel() {
  el("output-folder-label").textContent = state.outputDirHandle
    ? `Folder wyjściowy: ${state.outputDirHandle.name}`
    : fsdir.isSupported()
      ? "Folder wyjściowy: nie wybrano (wybierzesz przy pierwszym pobraniu)"
      : "Folder wyjściowy: ta przeglądarka nie wspiera wyboru — pliki polecą do Pobrane/scraper-client/…";
}

/** Zwraca uchwyt do folderu wyjściowego — pyta usera TYLKO raz na sesję (potem z pamięci/IndexedDB). */
async function ensureOutputDir() {
  if (state.outputDirHandle) return state.outputDirHandle;
  const handle = await fsdir.pickOutputDir();
  state.outputDirHandle = handle;
  updateFolderLabel();
  return handle;
}

async function onChangeFolder() {
  if (!fsdir.isSupported()) {
    toast("Ta przeglądarka nie wspiera wyboru folderu — pliki lądują w Pobrane/scraper-client/…", "err");
    return;
  }
  try {
    state.outputDirHandle = await fsdir.pickOutputDir();
    updateFolderLabel();
    toast("Folder wybrany: " + state.outputDirHandle.name);
  } catch (err) {
    toastError(err);
  }
}

/** Zapisuje Blob jako plik <folder wyjściowy>/<domena>/<filename> — albo, gdy File System Access
 * jest niedostępny, przez chrome.downloads do Pobrane/scraper-client/<domena>/<filename>. */
async function writeOutput(filename, blob) {
  const domainSlug = slugifyDomain(state.config.domain);
  if (fsdir.isSupported()) {
    const dir = await ensureOutputDir();
    const domainDir = await fsdir.subdir(dir, domainSlug);
    await fsdir.writeFile(domainDir, filename, blob);
    return;
  }
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: `scraper-client/${domainSlug}/${filename}`, saveAs: false });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

async function ensureScanResults() {
  await saveBridgeSettingsFromForm({ resetJob: false });
  await onApiKeyInputChange();
  if (state.scanProducts.length > 0) return true;
  if (state.scanning) return false;
  toast("Skanuję stronę automatycznie...");
  await onScanCatalog();
  if (state.scanProducts.length === 0) {
    toast("Nie udało się zebrać produktów z tej strony", "err");
    return false;
  }
  return true;
}

async function ensureAdapterRows() {
  if (state.adapterRows) return state.adapterRows;
  if (!(await ensureScanResults())) return null;

  readFormIntoConfig();
  const fallbackRows = productsToAdapterRows(state.scanProducts, state.config.image_links.public_base_url);
  if (!isAiAvailable()) {
    state.adapterRows = fallbackRows;
    toast("Wygenerowano strukturę bez AI - connector nie jest połączony");
    return state.adapterRows;
  }

  try {
    toast("AI tworzy finalną strukturę adaptera...");
    const aiResult = await generateAiRowsInBatches(state.scanProducts);
    state.adapterRows = mergeAiRowsWithImages(fallbackRows, aiResult.rows);
    el("scan-progress-text").textContent = `AI wygenerowało finalną strukturę dla ${state.adapterRows.length} produktów.`;
    toast(`AI wygenerowało dane (${aiResult.model || currentAiLabel()})`);
  } catch (err) {
    state.adapterRows = fallbackRows;
    toast(`AI niedostępne - używam lokalnej struktury (${err.message || err})`, "err");
  }
  return state.adapterRows;
}

async function onExportExcel() {
  const rows = await ensureAdapterRows();
  if (!rows) return;
  try {
    const blob = rowsToXlsxBlob(rows);
    await writeOutput(`${slugifyDomain(state.config.domain)}.xlsx`, blob);
    toast("Zapisano XLSX");
  } catch (err) {
    toastError(err);
  }
}

async function onExportCsv() {
  const rows = await ensureAdapterRows();
  if (!rows) return;
  try {
    const csv = rowsToCsv(rows);
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    await writeOutput(`${slugifyDomain(state.config.domain)}.csv`, blob);
    toast("Zapisano CSV");
  } catch (err) {
    toastError(err);
  }
}

async function onExportJsonPreview() {
  const rows = await ensureAdapterRows();
  if (!rows) return;
  try {
    const metadata = {
      domain: state.config.domain,
      generated_at: new Date().toISOString(),
      count: rows.length,
      image_links: state.config.image_links,
    };
    const blob = rowsToJsonBlob(rows, metadata);
    await writeOutput(`${slugifyDomain(state.config.domain)}.json`, blob);
    toast("Zapisano JSON");
  } catch (err) {
    toastError(err);
  }
}

function extensionFromUrl(url, contentType) {
  const fromCt = contentType && /image\/([a-z0-9.+-]+)/i.exec(contentType)?.[1];
  if (fromCt) return fromCt === "jpeg" ? "jpg" : fromCt.split("+")[0];
  try {
    const m = /\.([a-zA-Z0-9]{2,5})(?:[?#]|$)/.exec(new URL(url).pathname);
    if (m) return m[1].toLowerCase();
  } catch {
    /* URL niepoprawny — spadamy na domyślne rozszerzenie */
  }
  return "jpg";
}

const IMAGE_EXPORT_CAP = 500;
const IMAGE_FETCH_DELAY_MS = 120; // uprzejmość wobec CDN sklepu

async function onExportImages() {
  if (!(await ensureScanResults())) return;
  readFormIntoConfig();
  const progressEl = el("images-export-progress");
  const btn = el("export-images-btn");
  progressEl.hidden = false;
  btn.disabled = true;
  try {
    const domainSlug = slugifyDomain(state.config.domain);
    let imagesDirHandle = null;
    if (fsdir.isSupported()) {
      const dir = await ensureOutputDir();
      const domainDir = await fsdir.subdir(dir, domainSlug);
      imagesDirHandle = await fsdir.subdir(domainDir, "images");
    }

    // Zbieramy zadania pobrania z limitem bezpieczeństwa (IMAGE_EXPORT_CAP) — katalog może mieć
    // setki produktów × kilka zdjęć każdy, nie chcemy tego zrobić bez żadnego limitu.
    const tasks = [];
    state.scanProducts.forEach((product, idx) => {
      if (tasks.length >= IMAGE_EXPORT_CAP) return;
      const urls = product.fields?.images?.values || (product.fields?.images?.value ? [product.fields.images.value] : []);
      const baseName = slugifyDomain(fieldText(product.fields, "sku") || `produkt-${idx + 1}`);
      urls.forEach((url, i) => {
        if (tasks.length >= IMAGE_EXPORT_CAP) return;
        tasks.push({ url, name: i > 0 ? `${baseName}-${i + 1}` : baseName });
      });
    });

    let done = 0;
    let failed = 0;
    for (const task of tasks) {
      progressEl.textContent = `Pobieranie zdjęć: ${done + failed}/${tasks.length}…`;
      try {
        const res = await fetch(task.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const filename = `${task.name}.${extensionFromUrl(task.url, res.headers.get("content-type"))}`;
        if (imagesDirHandle) {
          await fsdir.writeFile(imagesDirHandle, filename, blob);
        } else {
          const objUrl = URL.createObjectURL(blob);
          try {
            await chrome.downloads.download({ url: objUrl, filename: `scraper-client/${domainSlug}/images/${filename}`, saveAs: false });
          } finally {
            setTimeout(() => URL.revokeObjectURL(objUrl), 10_000);
          }
        }
        done += 1;
      } catch (err) {
        failed += 1;
        log(`Błąd pobierania zdjęcia ${task.url}: ${err.message || err}`);
      }
      await new Promise((r) => setTimeout(r, IMAGE_FETCH_DELAY_MS));
    }

    progressEl.textContent = `Gotowe: ${done} zdjęć pobranych${failed ? `, ${failed} błędów (patrz log)` : ""}.`;
    toast(failed ? `Zdjęcia pobrane (${done}, ${failed} błędów)` : done > 0 ? "Zdjęcia pobrane" : "Nie znaleziono żadnych zdjęć w wynikach skanu");
  } catch (err) {
    toastError(err);
  } finally {
    btn.disabled = false;
  }
}

// --- pełny eksport przez framework/bridge -----------------------------------------

function bridgeDownloadHref(downloadUrl) {
  if (!downloadUrl) return "";
  return new URL(downloadUrl, currentFrameworkBaseUrl()).href;
}

function markFrameworkDownloadLink(link, downloadUrl, filename) {
  link.href = bridgeDownloadHref(downloadUrl);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.download = filename || "";
  link.dataset.downloadUrl = downloadUrl;
  link.dataset.downloadName = filename || "";
}

function appendFrameworkOutputGroup(box, label, files) {
  const line = document.createElement("div");
  line.appendChild(document.createTextNode(`${label}: `));
  if (!files.length) {
    line.appendChild(document.createTextNode("brak plików"));
    box.appendChild(line);
    return;
  }

  files.forEach((file, idx) => {
    if (idx > 0) line.appendChild(document.createTextNode(", "));
    if (file.download_url) {
      const link = document.createElement("a");
      markFrameworkDownloadLink(link, file.download_url, file.name || "");
      link.textContent = file.name || file.path;
      line.appendChild(link);
    } else {
      line.appendChild(document.createTextNode(file.path || file.name));
    }
  });
  box.appendChild(line);
}

function renderFrameworkOutputs(outputs) {
  const box = el("framework-outputs");
  box.innerHTML = "";
  appendFrameworkOutputGroup(box, "CSV", outputs?.csv || []);
  appendFrameworkOutputGroup(box, "Excel", outputs?.excel || []);
  const images = document.createElement("div");
  images.textContent = (outputs?.image_dirs || []).length
    ? `Zdjęcia: ${(outputs.image_dirs || []).join(", ")}`
    : "Zdjęcia: brak folderów";
  box.appendChild(images);
  if (outputs?.zip_download_url) {
    const zip = document.createElement("div");
    zip.appendChild(document.createTextNode("Archiwum: "));
    const link = document.createElement("a");
    markFrameworkDownloadLink(
      link,
      outputs.zip_download_url,
      state.bridge.jobId ? `${state.bridge.jobId}-outputs.zip` : "outputs.zip",
    );
    link.textContent = "ZIP";
    zip.appendChild(link);
    box.appendChild(zip);
  }
  if (outputs?.note) {
    const note = document.createElement("div");
    note.textContent = outputs.note;
    box.appendChild(note);
  }
  box.hidden = false;
}

function safeFrameworkDownloadName(filename) {
  return String(filename || "output").replace(/[\\/:*?"<>|]+/g, "_");
}

async function downloadCloudFrameworkOutput(downloadUrl, filename) {
  const url = bridgeDownloadHref(downloadUrl);
  const res = await fetch(url, { headers: currentFrameworkHeaders() });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.detail || "";
    } catch (_) {
      detail = await res.text().catch(() => "");
    }
    throw new Error(detail || `Cloud download HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url: objUrl,
      filename: `shark-scrap/cloud/${safeFrameworkDownloadName(filename)}`,
      saveAs: false,
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(objUrl), 10_000);
  }
}

async function onFrameworkOutputClick(event) {
  const link = event.target.closest("a[data-download-url]");
  if (!link || !isCloudMode()) return;
  event.preventDefault();
  try {
    await downloadCloudFrameworkOutput(link.dataset.downloadUrl, link.dataset.downloadName || link.download);
    toast("Pobieranie rozpoczęte");
  } catch (err) {
    toastError(err);
  }
}

function syncFrameworkModeUi() {
  const cloud = isCloudMode();
  el("framework-mode-local").checked = !cloud;
  el("framework-mode-cloud").checked = cloud;
  el("framework-mode-title").textContent = cloud ? "Cloud" : "Framework";
  el("local-api-field").hidden = cloud;
  el("cloud-api-field").hidden = !cloud;
  el("cloud-user-field").hidden = !cloud;
  el("bridge-base-url-input").value = state.bridge.localBaseUrl || "http://127.0.0.1:8765";
  el("cloud-base-url-input").value = state.bridge.cloudBaseUrl || "http://127.0.0.1:8766";
  el("cloud-user-id-input").value = state.bridge.cloudUserId || "dev-user";
  const modeText = cloud ? "Cloud: nie sprawdzono połączenia" : "Framework: nie sprawdzono połączenia";
  if (!state.bridge.connected && !state.bridge.jobId) {
    el("framework-job-progress").textContent = modeText;
    setBridgeStatus("nie sprawdzono", "idle");
  }
  refreshAiStatusUi();
}

async function saveBridgeSettingsFromForm(options = {}) {
  const resetJob = options?.resetJob !== false;
  state.bridge.mode = el("framework-mode-cloud").checked ? "cloud" : "local";
  state.bridge.localBaseUrl = el("bridge-base-url-input").value.trim() || "http://127.0.0.1:8765";
  state.bridge.cloudBaseUrl = el("cloud-base-url-input").value.trim() || "http://127.0.0.1:8766";
  state.bridge.cloudUserId = el("cloud-user-id-input").value.trim() || "dev-user";
  state.bridge.baseUrl = currentFrameworkBaseUrl();
  state.bridge.connected = false;
  if (resetJob) {
    state.bridge.jobId = null;
    el("framework-outputs").hidden = true;
  }
  syncFrameworkModeUi();
  await saveBridgeSettings({
    mode: state.bridge.mode,
    localBaseUrl: state.bridge.localBaseUrl,
    cloudBaseUrl: state.bridge.cloudBaseUrl,
    cloudUserId: state.bridge.cloudUserId,
  });
}

async function onCheckBridge() {
  await saveBridgeSettingsFromForm({ resetJob: false });
  const progress = el("framework-job-progress");
  const label = frameworkLabel();
  progress.textContent = `${label}: sprawdzanie połączenia…`;
  try {
    const client = bridgeClient();
    const health = await client.health();
    state.bridge.connected = health.status === "ok";
    if (state.bridge.connected) {
      if (isCloudMode()) {
        const me = await client.me();
        const billing = await client.billingStatus();
        const aiInfo = await client.aiCapabilities();
        setBridgeStatus(`${billing.plan} ${billing.jobs_used}/${billing.jobs_limit}`, billing.can_create_job ? "ok" : "err");
        progress.textContent = `Cloud: ${me.id}, plan ${billing.plan}, joby ${billing.jobs_used}/${billing.jobs_limit}, AI ${aiInfo.model}`;
        toast("Cloud API połączone");
        return true;
      }
      setBridgeStatus("połączony", "ok");
      progress.textContent = "Framework: połączony";
      toast("Framework połączony");
      return true;
    }
    setBridgeStatus("problem", "err");
    progress.textContent = `${label}: ${health.issues?.join("; ") || "status degraded"}`;
    return false;
  } catch (err) {
    state.bridge.connected = false;
    setBridgeStatus("offline", "err");
    progress.textContent = `${label}: offline`;
    toast(String(err.message || err), "err");
    log(`Błąd API pełnego eksportu: ${err.message || err}`);
    return false;
  }
}

async function pushCurrentConfigToBridge(client) {
  readFormIntoConfig();
  await saveConfig(state.config);
  const project = await client.createProject({
    domain: state.config.domain,
    start_url: state.config.start_url,
    mode: state.config.mode,
    source_name: state.config.source.name,
  });
  state.projectId = project.id;
  await client.pushConfig(project.id, state.config);
  return project;
}

async function pollFrameworkJob(client, jobId) {
  const progress = el("framework-job-progress");
  let lastJob = null;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    lastJob = await client.job(jobId);
    const label = JOB_STATUS_LABELS[lastJob.status] || lastJob.status;
    progress.textContent = `Framework: ${label}`;
    setBridgeStatus(label.toLowerCase(), lastJob.status === "failed" ? "err" : "ok");
    if (JOB_DONE_STATUSES.has(lastJob.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!lastJob || !JOB_DONE_STATUSES.has(lastJob.status)) {
    throw new Error("Timeout oczekiwania na job frameworka");
  }
  if (lastJob.status !== "completed") {
    const logs = await client.jobLogs(jobId).catch(() => ({ log_tail: "" }));
    throw new Error(lastJob.error_message || logs.log_tail || `Job zakończył się statusem ${lastJob.status}`);
  }
  const outputs = await client.jobOutputs(jobId);
  renderFrameworkOutputs(outputs);
  progress.textContent = `Framework: gotowe, job ${jobId}`;
}

async function pollCloudJob(client, jobId) {
  const progress = el("framework-job-progress");
  let job = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    job = await client.job(jobId);
    const label = JOB_STATUS_LABELS[job.status] || job.status;
    progress.textContent = `Cloud: ${label}`;
    setBridgeStatus(label.toLowerCase(), job.status === "failed" ? "err" : "ok");
    if (JOB_DONE_STATUSES.has(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!job) throw new Error("Cloud job nie został znaleziony");
  const outputs = await client.jobOutputs(jobId);
  renderFrameworkOutputs(outputs);
  const billing = await client.billingStatus().catch(() => null);
  const label = JOB_STATUS_LABELS[job.status] || job.status;
  if (billing) {
    setBridgeStatus(`${billing.plan} ${billing.jobs_used}/${billing.jobs_limit}`, billing.can_create_job ? "ok" : "err");
    progress.textContent = `Cloud: ${label}, joby ${billing.jobs_used}/${billing.jobs_limit}`;
  } else {
    setBridgeStatus(label.toLowerCase(), "ok");
    progress.textContent = `Cloud: ${label}`;
  }
  if (job.status !== "completed" && JOB_DONE_STATUSES.has(job.status)) {
    throw new Error(job.error_message || `Cloud job zakończył się statusem ${job.status}`);
  }
  return job;
}

async function onFrameworkExport() {
  const btn = el("framework-export-btn");
  const outputsBox = el("framework-outputs");
  btn.disabled = true;
  outputsBox.hidden = true;
  try {
    if (!(await ensureScanResults())) return;
    await saveBridgeSettingsFromForm();
    const client = bridgeClient();
    const connected = await onCheckBridge();
    if (!connected) return;

    const label = frameworkLabel();
    el("framework-job-progress").textContent = `${label}: wysyłanie konfiguracji…`;
    const project = await pushCurrentConfigToBridge(client);
    el("framework-job-progress").textContent = `${label}: start joba…`;
    const job = await client.startJob(project.id, ["csv", "excel"]);
    state.bridge.jobId = job.id;
    log(`Uruchomiono job ${isCloudMode() ? "cloud" : "frameworka"}: ${job.id}`);
    if (isCloudMode()) {
      const cloudJob = await pollCloudJob(client, job.id);
      toast(cloudJob.status === "completed" ? "Job cloud zakończony" : "Job cloud utworzony");
    } else {
      await pollFrameworkJob(client, job.id);
      toast("Pełny eksport zakończony");
    }
  } catch (err) {
    setBridgeStatus("błąd", "err");
    toast(String(err.message || err), "err");
    log(`Błąd pełnego eksportu: ${err.message || err}`);
  } finally {
    btn.disabled = false;
  }
}

/** Odświeża hero-checkbox "Użyj AI" + etykietę wg trybu: local token albo backend cloud. */
function refreshAiStatusUi() {
  const label = el("ai-status-label");
  const checkbox = el("use-ai-checkbox");
  if (isCloudMode()) {
    label.textContent = "AI przez Cloud - model wybiera backend";
    checkbox.disabled = false;
    checkbox.checked = true;
    return;
  }
  if (state.openai.apiKey) {
    label.textContent = `AI połączone, model: ${state.openai.model || "gpt-5.6-sol"}`;
    checkbox.disabled = false;
    checkbox.checked = true;
  } else {
    label.textContent = "AI niepołączone";
    checkbox.disabled = true;
    checkbox.checked = false;
  }
}

/** Wczytuje zapisany klucz OpenAI z chrome.storage.local do state + formularza ustawień. */
async function loadAiSettingsIntoUi() {
  state.openai = await loadOpenAiSettings();
  if (state.openai.model === "gpt-5.6-luna") {
    state.openai.model = "";
    await saveOpenAiSettings(state.openai);
  }
  el("openai-api-key-input").value = state.openai.apiKey || "";
  el("openai-model-input").value = state.openai.model || "";
  refreshAiStatusUi();
}

async function onApiKeyInputChange() {
  const apiKey = el("openai-api-key-input").value.trim();
  const model = el("openai-model-input").value.trim();
  state.openai = { apiKey, model };
  state.adapterRows = null;
  await saveOpenAiSettings(state.openai);
  refreshAiStatusUi();
}

async function onImageDomainChange() {
  readFormIntoConfig();
  state.adapterRows = null;
  await saveConfig(state.config);
}

async function onSaveAiSettings() {
  const apiKey = el("openai-api-key-input").value.trim();
  const model = el("openai-model-input").value.trim();
  if (!apiKey) {
    toast("Podaj token połączenia AI", "err");
    return;
  }
  state.openai = { apiKey, model };
  await saveOpenAiSettings(state.openai);
  refreshAiStatusUi();
  toast("Codex connector połączony");
}

async function onClearAiSettings() {
  state.openai = { apiKey: "", model: "" };
  state.adapterRows = null;
  await saveOpenAiSettings(state.openai);
  el("openai-api-key-input").value = "";
  el("openai-model-input").value = "";
  refreshAiStatusUi();
  toast("Codex connector rozłączony");
}

// --- init ---------------------------------------------------------------------------

async function init() {
  const tab = await getActiveTab();
  state.tabId = tab.id;
  const url = new URL(tab.url);
  state.domain = url.hostname;
  state.url = tab.url;

  const existing = await loadConfig(state.domain);
  state.config = existing || createDefaultConfig(state.domain, tab.url);
  if (!existing) state.config.start_url = tab.url;

  renderForm();

  state.outputDirHandle = await fsdir.restoreOutputDir();
  updateFolderLabel();

  const bridgeSettings = await loadBridgeSettings();
  state.bridge = {
    ...state.bridge,
    ...bridgeSettings,
    connected: false,
    jobId: null,
  };
  syncFrameworkModeUi();

  await loadAiSettingsIntoUi();
  el("save-ai-settings-btn").addEventListener("click", onSaveAiSettings);
  el("clear-ai-settings-btn").addEventListener("click", onClearAiSettings);
  el("openai-api-key-input").addEventListener("change", onApiKeyInputChange);
  el("image-base-url-input").addEventListener("change", onImageDomainChange);
  el("bridge-base-url-input").addEventListener("change", saveBridgeSettingsFromForm);
  el("cloud-base-url-input").addEventListener("change", saveBridgeSettingsFromForm);
  el("cloud-user-id-input").addEventListener("change", saveBridgeSettingsFromForm);
  el("framework-mode-local").addEventListener("change", saveBridgeSettingsFromForm);
  el("framework-mode-cloud").addEventListener("change", saveBridgeSettingsFromForm);
  el("check-bridge-btn").addEventListener("click", onCheckBridge);
  el("framework-export-btn").addEventListener("click", onFrameworkExport);
  el("framework-outputs").addEventListener("click", onFrameworkOutputClick);

  el("scan-btn").addEventListener("click", onScanCatalog);
  el("stop-scan-btn").addEventListener("click", onStopScan);
  el("change-folder-btn").addEventListener("click", onChangeFolder);
  el("export-excel-btn").addEventListener("click", onExportExcel);
  el("export-csv-btn").addEventListener("click", onExportCsv);
  el("export-json-preview-btn").addEventListener("click", onExportJsonPreview);
  el("export-images-btn").addEventListener("click", onExportImages);

  el("detect-btn").addEventListener("click", onDetectProduct);
  el("fields-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".pick-btn");
    if (btn) onPickField(btn.dataset.field);
  });
  el("detect-listing-btn").addEventListener("click", onDetectListing);

  chrome.runtime.onMessage.addListener(onPickerMessage);
}

init().catch((err) => {
  console.error(err);
  toast("Błąd inicjalizacji panelu: " + (err.message || err), "err");
});
