/**
 * @file Eksport do pliku — działa niezależnie od bridge'a. Dwie kategorie:
 *  1) `downloadConfig` — eksport CONFIGU (wymaganie MVP #10), przez chrome.downloads.
 *  2) `productsToCsv`/`productsToXlsxBlob`/`productsToPlainRows` — czyste serializery wyników
 *     auto-skanu (SCAN_CATALOG w content/detector.js) do CSV/XLSX — używane przez przycisk
 *     "Pobierz wyniki" w sidepanel
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

function xmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch]));
}

function columnName(index) {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function sheetXml(headers, rows) {
  const allRows = [headers, ...rows.map((row) => headers.map((h) => row[h] ?? ""))];
  const body = allRows
    .map((cells, rowIndex) => {
      const r = rowIndex + 1;
      const cellXml = cells
        .map((value, colIndex) => `<c r="${columnName(colIndex)}${r}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`)
        .join("");
      return `<row r="${r}">${cellXml}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${body}</sheetData>
</worksheet>`;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function concatBytes(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function zipStore(files) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const localHeader = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(name.length), ...u16(0),
    ]);
    const local = concatBytes([localHeader, name, data]);
    const central = new Uint8Array([
      ...u32(0x02014b50),
      ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ...name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralDir = concatBytes(centrals);
  const localData = concatBytes(locals);
  const end = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(centralDir.length), ...u32(localData.length), ...u16(0),
  ]);
  return concatBytes([localData, centralDir, end]);
}

/**
 * Tworzy prawdziwy plik XLSX bez zależności od zewnętrznych bibliotek. ZIP jest zapisany metodą
 * "store" (bez kompresji), co jest wystarczające dla arkusza z wynikami skanu.
 * @param {{url:string, fields:Record<string,any>, ok:boolean, error?:string}[]} products
 * @param {string[]} fieldOrder
 */
export function productsToXlsxBlob(products, fieldOrder) {
  const headers = ["product_url", "ok", "error", ...fieldOrder];
  const rows = productsToPlainRows(products, fieldOrder);
  const files = [
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Produkty" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
    },
    { name: "xl/worksheets/sheet1.xml", content: sheetXml(headers, rows) },
  ];
  return new Blob([zipStore(files)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
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
