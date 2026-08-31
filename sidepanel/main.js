import { PRODUCT_FIELDS, createDefaultConfig, slugifyDomain } from "../lib/schema.js";
import { loadConfig, saveConfig, loadBridgeSettings, saveBridgeSettings, loadOpenAiSettings, saveOpenAiSettings } from "../lib/storage.js";
import { createBridgeClient } from "../lib/bridge-client.js";
import { downloadConfig, productsToCsv, productsToXlsxBlob } from "../lib/export.js";
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

/** @type {{tabId:number, domain:string, url:string, config: import('../lib/schema.js').ScraperConfig, projectId: string|null, scanning: boolean, scanProducts: any[], outputDirHandle: any, openai: {apiKey:string, model:string}}} */
const state = { tabId: null, domain: "", url: "", config: null, projectId: null, scanning: false, scanProducts: [], outputDirHandle: null, openai: { apiKey: "", model: "" } };

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
  el("max-pages-input").value = c.list_page.pagination.max_pages || 20;

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
    max_pages: Number(el("max-pages-input").value) || 20,
    experimental: pMode === "load_more" || pMode === "infinite_scroll",
  };

  c.image_links.public_base_url = el("image-base-url-input").value.trim();
  c.image_links.brand_segment = el("image-brand-input").value.trim();
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
  readFormIntoConfig();
  state.scanning = true;
  state.scanProducts = [];
  el("results-tbody").innerHTML = "";
  el("results-count").textContent = "0";
  el("results-card").hidden = true;
  renderWarnings([]);

  el("scan-btn").disabled = true;
  el("stop-scan-btn").hidden = false;
  el("scan-progress-wrap").hidden = false;
  el("scan-progress-fill").style.width = "0%";
  el("scan-progress-text").textContent = "Wykrywanie listy i pól produktowych…";

  try {
    const maxPages = Number(el("max-pages-input").value) || 20;
    const useAI = el("use-ai-checkbox").checked;
    const result = await sendToTab(state.tabId, {
      action: "SCAN_CATALOG",
      options: { maxPages, useAI, apiKey: state.openai.apiKey, aiModel: state.openai.model },
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

function requireScanResults() {
  if (state.scanProducts.length === 0) {
    toast("Brak wyników — najpierw kliknij „Skanuj sklep”", "err");
    return false;
  }
  return true;
}

async function onExportExcel() {
  if (!requireScanResults()) return;
  readFormIntoConfig();
  try {
    const blob = productsToXlsxBlob(state.scanProducts, PRODUCT_FIELDS);
    await writeOutput(`${slugifyDomain(state.config.domain)}.xlsx`, blob);
    toast("Zapisano XLSX");
  } catch (err) {
    toastError(err);
  }
}

async function onExportCsv() {
  if (!requireScanResults()) return;
  readFormIntoConfig();
  try {
    const csv = productsToCsv(state.scanProducts, PRODUCT_FIELDS);
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    await writeOutput(`${slugifyDomain(state.config.domain)}.csv`, blob);
    toast("Zapisano CSV");
  } catch (err) {
    toastError(err);
  }
}

async function onExportJsonPreview() {
  if (!requireScanResults()) return;
  readFormIntoConfig();
  try {
    const payload = {
      domain: state.config.domain,
      generated_at: new Date().toISOString(),
      count: state.scanProducts.length,
      products: state.scanProducts,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
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
  if (!requireScanResults()) return;
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

// --- zapis lokalny / eksport configu ------------------------------------------------

async function onSaveConfig() {
  readFormIntoConfig();
  await saveConfig(state.config);
  toast("Zapisano konfigurację dla domeny " + state.config.domain);
}

async function onExportJson() {
  readFormIntoConfig();
  await downloadConfig(state.config);
  toast("Wyeksportowano JSON");
}

// --- integracja z bridgem ------------------------------------------------------------

function bridge() {
  return createBridgeClient(el("bridge-url-input").value.trim());
}

async function onBridgeCheck() {
  try {
    const res = await bridge().health();
    el("bridge-dot").className = "dot ok";
    el("bridge-status-text").textContent = `bridge: ok (${res.project_root ? "połączono" : "działa"})`;
    log("Health check OK: " + JSON.stringify(res));
    await saveBridgeSettings({ baseUrl: el("bridge-url-input").value.trim() });
  } catch (err) {
    el("bridge-dot").className = "dot err";
    el("bridge-status-text").textContent = "bridge: niedostępny";
    log("Health check FAILED: " + (err.message || err));
    toast("Bridge niedostępny — sprawdź czy jest uruchomiony", "err");
  }
}

/** Odświeża hero-checkbox "Użyj AI" + etykietę wg stanu state.openai (klucz z chrome.storage.local). */
function refreshAiStatusUi() {
  const label = el("ai-status-label");
  const checkbox = el("use-ai-checkbox");
  if (state.openai.apiKey) {
    label.textContent = `Klucz zapisany, model: ${state.openai.model || "gpt-5.6-luna"}`;
    checkbox.disabled = false;
  } else {
    label.textContent = "Brak klucza API - otwórz ustawienia";
    checkbox.disabled = true;
    checkbox.checked = false;
  }
}

/** Wczytuje zapisany klucz OpenAI z chrome.storage.local do state + formularza ustawień. */
async function loadAiSettingsIntoUi() {
  state.openai = await loadOpenAiSettings();
  el("openai-api-key-input").value = state.openai.apiKey || "";
  el("openai-model-input").value = state.openai.model || "";
  refreshAiStatusUi();
}

async function onSaveAiSettings() {
  const apiKey = el("openai-api-key-input").value.trim();
  const model = el("openai-model-input").value.trim();
  if (!apiKey) {
    toast("Podaj klucz API Codex / OpenAI (sk-...)", "err");
    return;
  }
  state.openai = { apiKey, model };
  await saveOpenAiSettings(state.openai);
  refreshAiStatusUi();
  toast("Zapisano klucz API");
}

async function onClearAiSettings() {
  state.openai = { apiKey: "", model: "" };
  await saveOpenAiSettings(state.openai);
  el("openai-api-key-input").value = "";
  el("openai-model-input").value = "";
  refreshAiStatusUi();
  toast("Usunięto klucz AI z tej przeglądarki");
}

async function onCreateProject() {
  readFormIntoConfig();
  try {
    const res = await bridge().createProject({
      domain: state.config.domain,
      start_url: state.config.start_url,
      mode: state.config.mode,
      source_name: state.config.source.name,
    });
    state.projectId = res.id;
    el("project-id-label").textContent = `project_id: ${res.id}`;
    log("Utworzono/zaktualizowano projekt: " + JSON.stringify(res));
    toast("Projekt gotowy: " + res.id);
  } catch (err) {
    toast(String(err.message || err), "err");
    log("Błąd tworzenia projektu: " + (err.message || err));
  }
}

async function withProject(fn) {
  if (!state.projectId) {
    toast("Najpierw utwórz projekt", "err");
    return;
  }
  try {
    await fn(state.projectId);
  } catch (err) {
    toast(String(err.message || err), "err");
    log("Błąd: " + (err.message || err));
  }
}

async function onPushConfig() {
  readFormIntoConfig();
  await withProject(async (id) => {
    const res = await bridge().pushConfig(id, state.config);
    log("Konfiguracja wysłana: " + JSON.stringify(res));
    toast("Konfiguracja wysłana do bridge");
  });
}

async function onGenerateAdapter() {
  await withProject(async (id) => {
    const res = await bridge().generateAdapter(id);
    log("Wygenerowano adapter: " + JSON.stringify(res, null, 2));
    toast(res.patched ? "Adapter wygenerowany i wypełniony" : "Adapter zeskafoldowany (wymaga ręcznego uzupełnienia)");
  });
}

async function onRun() {
  const formats = [];
  if (el("export-csv").checked) formats.push("csv");
  if (el("export-excel").checked) formats.push("excel");
  await withProject(async (id) => {
    const res = await bridge().run(id, formats);
    log("Start uruchomienia: " + JSON.stringify(res));
    toast("Scraper uruchomiony w tle (zdjęcia pobiorą się automatycznie)");
  });
}

async function onStatus() {
  await withProject(async (id) => {
    const res = await bridge().status(id);
    log("Status: " + JSON.stringify(res, null, 2));
  });
}

async function onOutputs() {
  await withProject(async (id) => {
    const res = await bridge().outputs(id);
    log("Outputy: " + JSON.stringify(res, null, 2));
  });
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

  const bridgeSettings = await loadBridgeSettings();
  el("bridge-url-input").value = bridgeSettings.baseUrl;

  renderForm();

  state.outputDirHandle = await fsdir.restoreOutputDir();
  updateFolderLabel();

  await loadAiSettingsIntoUi();
  el("save-ai-settings-btn").addEventListener("click", onSaveAiSettings);
  el("clear-ai-settings-btn").addEventListener("click", onClearAiSettings);

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
  el("save-config-btn").addEventListener("click", onSaveConfig);
  el("export-json-btn").addEventListener("click", onExportJson);
  el("bridge-check-btn").addEventListener("click", onBridgeCheck);
  el("create-project-btn").addEventListener("click", onCreateProject);
  el("push-config-btn").addEventListener("click", onPushConfig);
  el("generate-adapter-btn").addEventListener("click", onGenerateAdapter);
  el("run-btn").addEventListener("click", onRun);
  el("status-btn").addEventListener("click", onStatus);
  el("outputs-btn").addEventListener("click", onOutputs);

  chrome.runtime.onMessage.addListener(onPickerMessage);

  onBridgeCheck();
}

init().catch((err) => {
  console.error(err);
  toast("Błąd inicjalizacji panelu: " + (err.message || err), "err");
});
