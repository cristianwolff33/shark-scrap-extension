/**
 * @file Eksport do pliku — działa niezależnie od bridge'a. Dwie kategorie:
 *  1) `downloadConfig` — eksport CONFIGU (wymaganie MVP #10), przez chrome.downloads.
 *  2) `productsToCsv`/`productsToExcelHtml`/`productsToPlainRows` — czyste serializery wyników
 *     auto-skanu (SCAN_CATALOG w content/detector.js) do CSV/"Excel" (HTML-trick, .xls, bez
 *     biblioteki do binarnego .xlsx) — używane przez przycisk "Pobierz wyniki" w sidepanel
 *     (main.js), który zapisuje przez File System Access API (extension/lib/fsdir.js) do
 *     folderu wybranego przez usera. To świadomie "surowy" eksport strony klienckiej: zero
 *     normalizacji/walidacji SKU/EAN/cen — ta logika ZOSTAJE w istniejącym frameworku
 *     (kanoniczny CSV/Excel + zdjęcia z poprawnymi linkami nadal idą przez bridge -> run.py,
 *     sekcja "Eksport pełny (tryb zaawansowany)").
 */

/** @param {import('./schema.js').ScraperConfig} config */
export function configToJsonBlob(config) {
  const payload = { ...config, generated_at: new Date().toISOString() };
  return new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
}

/** Pobiera plik JSON przez chrome.downloads (wymaga uprawnienia "downloads"). */
export async function downloadConfig(config) {
  const blob = configToJsonBlob(config);
  const url = URL.createObjectURL(blob);
  const filename = `adapter_requests/${config.domain}.json`;
  try {
    await chrome.downloads.download({ url, filename, saveAs: false });
  } finally {
    // Zwolnienie URL po chwili — chrome.downloads potrzebuje czasu na odczyt blob:.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** Wyciąga samą wartość podglądu z FieldSpec (albo pusty string), do zapisu w CSV/JSON. */
function fieldValue(spec) {
  if (!spec) return "";
  const v = spec.value;
  if (v === undefined || v === null) return "";
  return String(v);
}

/** @param {{url:string, fields:Record<string,any>, ok:boolean, error?:string}[]} products */
export function productsToPlainRows(products, fieldOrder) {
  return (products || []).map((p) => {
    /** @type {Record<string,string>} */
    const row = { product_url: p.url, ok: p.ok !== false ? "true" : "false", error: p.error || "" };
    for (const field of fieldOrder) {
      row[field] = fieldValue(p.fields?.[field]);
    }
    return row;
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

/**
 * Serializuje produkty do HTML-a rozpoznawanego przez Excel jako arkusz (klasyczny trik
 * "HTML jako .xls" — zapisywany z rozszerzeniem .xls i mimetype application/vnd.ms-excel,
 * Excel otwiera to jako prawdziwy arkusz z kolumnami, bez potrzeby biblioteki do zapisu
 * binarnego formatu .xlsx). Czysta funkcja — testowalna bez chrome.*.
 * @param {{url:string, fields:Record<string,any>, ok:boolean, error?:string}[]} products
 * @param {string[]} fieldOrder
 */
export function productsToExcelHtml(products, fieldOrder) {
  const headers = ["product_url", "ok", "error", ...fieldOrder];
  const rows = productsToPlainRows(products, fieldOrder);
  const theadRow = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const bodyRows = rows
    .map((row) => `<tr>${headers.map((h) => `<td>${escapeHtml(row[h])}</td>`).join("")}</tr>`)
    .join("\n");
  return (
    `<html xmlns:x="urn:schemas-microsoft-com:office:excel">\n` +
    `<head><meta charset="utf-8" /></head>\n` +
    `<body><table border="1"><thead><tr>${theadRow}</tr></thead><tbody>\n${bodyRows}\n</tbody></table></body>\n` +
    `</html>`
  );
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Serializuje listę produktów (z auto-skanu) do CSV. Czysta funkcja — testowalna bez chrome.*.
 * @param {{url:string, fields:Record<string,any>, ok:boolean, error?:string}[]} products
 * @param {string[]} fieldOrder - kolejność kolumn pól (np. PRODUCT_FIELDS z schema.js)
 */
export function productsToCsv(products, fieldOrder) {
  const headers = ["product_url", "ok", "error", ...fieldOrder];
  const rows = productsToPlainRows(products, fieldOrder);
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  return lines.join("\r\n");
}

