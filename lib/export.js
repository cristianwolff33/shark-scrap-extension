/**
 * @file Eksport do pliku — działa niezależnie od bridge'a. Dwie kategorie:
 *  1) `downloadConfig` — eksport CONFIGU (wymaganie MVP #10), przez chrome.downloads.
 *  2) Eksport finalnych wierszy adapter-request do CSV/XLSX/JSON. Wtyczka działa bez bridge'a:
 *     skanuje stronę, normalizuje dane lokalnie i opcjonalnie wzbogaca je przez AI.
 */

export const ADAPTER_COLUMNS = [
  "Cena",
  "SKU",
  "EAN",
  "OPIS",
  "opis_dodatkowy1",
  "opis_dodatkowy2",
  "opis_dodatkowy3",
  "opis_dodatkowy4",
  "Marka",
  "TYTUŁ OFERTY",
  "KOD PRODUCENTA",
  "GPSR",
  "UWAGI",
];

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

function fieldValues(spec) {
  if (!spec) return [];
  const values = Array.isArray(spec.values) ? spec.values : spec.value ? [spec.value] : [];
  return values.map((v) => String(v || "").trim()).filter(Boolean);
}

function productField(product, name) {
  return fieldValue(product?.fields?.[name]).trim();
}

function productImages(product) {
  return fieldValues(product?.fields?.images);
}

export function normalizeImageTemplate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes("[sku]") || raw.includes("[rozszerzenie]")) return raw;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return `${withProtocol.replace(/\/+$/, "")}/produkty/[marka]/[sku].[rozszerzenie]`;
}

function extensionFromUrl(url) {
  try {
    const match = /\.([a-zA-Z0-9]{2,5})(?:[?#]|$)/.exec(new URL(url).pathname);
    return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
  } catch {
    return "jpg";
  }
}

// WordPress/WooCommerce generuje miniaturki jako "<nazwa>-SZERxWYS.<ext>" (myślnik), Shopify i
// część innych CDN-ów jako "<nazwa>_SZERxWYS.<ext>" (podkreślnik), czasem z dodatkowym opisem
// przycięcia typu "_crop_center" — w obu przypadkach oryginalny plik siedzi pod "<nazwa>.<ext>"
// bez sufiksu.
const THUMBNAIL_SUFFIX_RE = /[-_]\d{2,5}x\d{2,5}(?:_[a-zA-Z]+)*(?=\.[a-zA-Z0-9]+(?:[?#].*)?$)/;

// Popularne nazwy parametrów query stringa sterujących rozmiarem obrazka w CDN-ach opartych o
// resizing-as-a-service (Cloudinary/Imgix/Cloudflare Images i podobne).
const SIZE_QUERY_PARAMS = ["width", "height", "w", "h", "size", "resize", "sz", "quality", "q"];

// Część sklepów (np. Rozetka) NIE koduje rozmiaru w nazwie pliku ani w query stringu, tylko w
// SEGMENCIE ŚCIEŻKI — różne rozmiary leżą w osobnych folderach, np.
// ".../goods/images/medium/123.jpg" zamiast ".../images/123-600x600.jpg". Zweryfikowane live na
// rozetka.com.ua: "/medium/" dawało 80x99px, "/original/" to samo zdjęcie w 2112x2608px.
const SMALL_SIZE_PATH_SEGMENT_RE = /\/(thumbs?|thumbnails?|mini|tiny|icon|preview|small|medium|mid)\//i;
const LARGE_SIZE_PATH_SEGMENTS = ["original", "large", "big", "full", "huge", "zoom", "xl"];

/**
 * Zgaduje MOŻLIWE pełnowymiarowe warianty URL-a zdjęcia z typowych wzorców nazewnictwa/query
 * stringa/ścieżki miniaturek (sufiks w nazwie pliku, parametry rozmiaru w query stringu, albo
 * osobny segment ścieżki oznaczający rozmiar — patrz SMALL_SIZE_PATH_SEGMENT_RE). To WYŁĄCZNIE
 * heurystyki — żaden zwrócony URL nie jest gwarantowany, że istnieje (plik może naprawdę się tak
 * nazywać, strona może nie używać żadnej z tych konwencji). WYWOŁUJĄCY MUSI zweryfikować każdy
 * kandydat realnym fetch() i spaść na oryginalny URL, jeśli żaden nie zadziała — nigdy nie ufamy
 * temu w ciemno (patrz fetchImageWithFullSizeUpgrade w sidepanel/main.js). Zwraca [] (pustą
 * listę), gdy URL nie pasuje do żadnego wzorca.
 * @param {string} url
 * @returns {string[]}
 */
export function guessFullSizeImageUrls(url) {
  const value = String(url || "");
  if (!value) return [];
  const candidates = [];

  const suffixStripped = value.replace(THUMBNAIL_SUFFIX_RE, "");
  if (suffixStripped !== value) candidates.push(suffixStripped);

  if (SMALL_SIZE_PATH_SEGMENT_RE.test(value)) {
    for (const large of LARGE_SIZE_PATH_SEGMENTS) {
      candidates.push(value.replace(SMALL_SIZE_PATH_SEGMENT_RE, `/${large}/`));
    }
  }

  try {
    const u = new URL(value);
    let changed = false;
    for (const param of SIZE_QUERY_PARAMS) {
      if (u.searchParams.has(param)) {
        u.searchParams.delete(param);
        changed = true;
      }
    }
    if (changed) candidates.push(u.href);
  } catch {
    // URL względny albo niepoprawny — pomijamy wariant query-string, zostaje sam suffiksowy (jeśli był)
  }

  return candidates;
}

/** Wariant zwracający tylko PIERWSZEGO kandydata — zachowany dla zgodności z istniejącymi
 * wywołaniami/testami; nowy kod powinien używać guessFullSizeImageUrls i próbować wszystkich. */
export function guessFullSizeImageUrl(url) {
  return guessFullSizeImageUrls(url)[0] || "";
}

/**
 * Zamienia nazwę marki na bezpieczny segment ścieżki/URL-a (folder na dysku ORAZ [marka] w
 * linku do zdjęcia muszą być tym samym stringiem, inaczej link w CSV/XLSX nie zgadzałby się z
 * realną strukturą folderów, które user wrzuci na swoją domenę — patrz onExportImages w
 * sidepanel/main.js, które importuje tę samą funkcję).
 */
export function slugifyBrand(brand) {
  return (
    String(brand || "")
      .trim()
      .replace(/ł/g, "l")
      .replace(/Ł/g, "L")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "") // diakrytyki (ą,ć,ę,ń,ó,ś,ź,ż) po dekompozycji NFKD
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "bez-marki"
  );
}

function imageLink(template, sku, sourceUrl, brand) {
  const ext = extensionFromUrl(sourceUrl);
  if (!template) return sourceUrl;
  return template
    .replaceAll("[sku]", sku || "produkt")
    .replaceAll("[rozszerzenie]", ext)
    .replaceAll("[marka]", slugifyBrand(brand));
}

function splitDescription(description) {
  const text = String(description || "").replace(/<img\b[^>]*>/gi, "").trim();
  if (!text) return ["", "", "", ""];
  const plain = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return [
    `<strong>Opis produktu</strong><br>${plain}`,
    "<strong>Najważniejsze cechy</strong><br>",
    "<strong>Zastosowanie</strong><br>",
    "<strong>Parametry produktu</strong><br>",
  ];
}

/**
 * Lokalny fallback budujący finalną strukturę jak ADAPTER_REQUEST.md. AI może później nadpisać
 * te wartości lepszym tytułem/opisem, ale kolumny są gotowe nawet bez klucza API.
 */
export function productsToAdapterRows(products, imageTemplate = "") {
  const template = normalizeImageTemplate(imageTemplate);
  return (products || []).map((product, idx) => {
    const sku = productField(product, "sku") || `produkt-${idx + 1}`;
    const descriptionParts = splitDescription(productField(product, "description"));
    const title = productField(product, "product_name");
    const brand = productField(product, "brand");
    const row = {
      Cena: productField(product, "price"),
      SKU: sku,
      EAN: productField(product, "ean"),
      OPIS: descriptionParts[0],
      opis_dodatkowy1: descriptionParts[0],
      opis_dodatkowy2: descriptionParts[1],
      opis_dodatkowy3: descriptionParts[2],
      opis_dodatkowy4: descriptionParts[3],
      Marka: brand,
      "TYTUŁ OFERTY": title,
      "KOD PRODUCENTA": productField(product, "sku"),
      GPSR: productField(product, "gpsr"),
      UWAGI: product.ok === false ? product.error || "Błąd skanu produktu" : "",
    };
    productImages(product).forEach((url, imageIdx) => {
      row[`zdj${imageIdx + 1}`] = imageLink(template, sku, url, brand);
    });
    return row;
  });
}

export function headersForRows(rows) {
  const imageHeaders = new Set();
  for (const row of rows || []) {
    for (const key of Object.keys(row)) {
      if (/^zdj\d+$/i.test(key)) imageHeaders.add(key);
    }
  }
  const sortedImages = Array.from(imageHeaders).sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")));
  return [...ADAPTER_COLUMNS, ...sortedImages];
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

/** `file.content` może być stringiem (XML arkusza) albo już gotowymi bajtami (Uint8Array — zdjęcia). */
function zipStore(files) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = file.content instanceof Uint8Array ? file.content : encoder.encode(file.content);
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

/**
 * Pakuje dowolny zestaw plików (nazwa + bajty, ścieżki mogą zawierać "/" jako podfoldery
 * wewnątrz ZIP-a) do jednego pliku ZIP. Wspólny fundament dla imagesToZipBlob oraz "Download
 * Full" (sidepanel/main.js: pakuje CSV+XLSX+JSON+zdjęcia razem w jeden ZIP z folderem
 * <nazwa-strony> w środku) — bo chrome.downloads.download({filename:"podfolder/plik"}) okazał
 * się niewiarygodny na części systemów (plik lądował pod losową nazwą zamiast we
 * wskazanym podfolderze), a struktura folderów WEWNĄTRZ ZIP-a zawsze działa tak samo,
 * niezależnie od przeglądarki/systemu — bo to sam format pliku, nie zachowanie przeglądarki.
 * @param {{name: string, bytes: Uint8Array}[]} files
 */
export function filesToZipBlob(files) {
  const entries = (files || []).map((f) => ({ name: f.name, content: f.bytes }));
  return new Blob([zipStore(entries)], { type: "application/zip" });
}

/**
 * Pakuje pobrane zdjęcia (już jako surowe bajty, po fetch) do JEDNEGO pliku ZIP — do masowego
 * pobrania jedną operacją zamiast N osobnych wpisów w chrome.downloads. Bez tego, na przeglądarce
 * bez wsparcia File System Access API (patrz fsdir.js), każde zdjęcie lądowało jako osobny,
 * widoczny download w Chrome — bardzo uciążliwe przy dziesiątkach/setkach zdjęć.
 * @param {{name: string, bytes: Uint8Array}[]} images
 */
export function imagesToZipBlob(images) {
  return filesToZipBlob(images);
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function rowsToCsv(rows) {
  const headers = headersForRows(rows);
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows || []) {
    lines.push(headers.map((h) => csvEscape(row[h] || "")).join(","));
  }
  return lines.join("\r\n");
}

export function rowsToXlsxBlob(rows) {
  const headers = headersForRows(rows);
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
    { name: "xl/worksheets/sheet1.xml", content: sheetXml(headers, rows || []) },
  ];
  return new Blob([zipStore(files)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function rowsToJsonBlob(rows, metadata = {}) {
  return new Blob([JSON.stringify({ ...metadata, rows }, null, 2)], { type: "application/json" });
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
