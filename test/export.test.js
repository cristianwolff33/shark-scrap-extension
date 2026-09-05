import { test } from "node:test";
import assert from "node:assert/strict";
import {
  headersForRows,
  normalizeImageTemplate,
  productsToAdapterRows,
  productsToPlainRows,
  productsToCsv,
  productsToExcelHtml,
  productsToXlsxBlob,
  rowsToCsv,
  rowsToXlsxBlob,
  imagesToZipBlob,
  slugifyBrand,
} from "../lib/export.js";

/** Szuka ciągu bajtów `needle` gdziekolwiek w `haystack` — wystarczy do sprawdzenia, że metoda
 * "store" (bez kompresji) faktycznie osadziła oryginalne, nietknięte bajty zdjęcia w ZIP-ie. */
function containsBytes(haystack, needle) {
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return needle.length === 0;
}

const FIELD_ORDER = ["product_name", "sku", "price"];

const SAMPLE_PRODUCTS = [
  {
    url: "https://sklep.pl/p/1",
    ok: true,
    fields: {
      product_name: { value: "Krzesło biurowe" },
      sku: { value: "X200-BLK" },
      ean: { value: "5901234567890" },
      brand: { value: "Acme" },
      price: { value: "199.99" },
      description: { value: "<p>Wygodne krzesło do biura.</p><img src='x.jpg'>" },
      images: { values: ["https://cdn.sklep.pl/x200.jpg", "https://cdn.sklep.pl/x200-side.png"] },
    },
  },
  {
    url: "https://sklep.pl/p/2",
    ok: false,
    error: "HTTP 500 dla https://sklep.pl/p/2",
    fields: {},
  },
  {
    url: "https://sklep.pl/p,3",
    ok: true,
    fields: {
      product_name: { value: 'Stół "Dębowy", 120cm' },
      sku: { value: "T-120" },
      price: { value: undefined },
    },
  },
];

test("productsToPlainRows spłaszcza fields wg podanej kolejności i zachowuje url/ok/error", () => {
  const rows = productsToPlainRows(SAMPLE_PRODUCTS, FIELD_ORDER);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    product_url: "https://sklep.pl/p/1",
    ok: "true",
    error: "",
    product_name: "Krzesło biurowe",
    sku: "X200-BLK",
    price: "199.99",
  });
  assert.equal(rows[1].ok, "false");
  assert.equal(rows[1].error, "HTTP 500 dla https://sklep.pl/p/2");
  assert.equal(rows[2].price, ""); // brak wartości => pusty string, nie "undefined"
});

test("productsToCsv generuje poprawny nagłówek i wiersze z escapowaniem przecinków/cudzysłowów", () => {
  const csv = productsToCsv(SAMPLE_PRODUCTS, FIELD_ORDER);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "product_url,ok,error,product_name,sku,price");
  assert.equal(lines.length, 4); // nagłówek + 3 produkty
  assert.match(lines[1], /^https:\/\/sklep\.pl\/p\/1,true,,Krzesło biurowe,X200-BLK,199\.99$/);
  // URL z przecinkiem w środku musi być zacytowany
  assert.match(lines[3], /^"https:\/\/sklep\.pl\/p,3"/);
  // Cudzysłów w wartości podwojony i całość zacytowana (bo zawiera przecinek)
  assert.ok(lines[3].includes('"""Stół ""Dębowy"", 120cm"""') || lines[3].includes('Stół ""Dębowy""'));
});

test("productsToCsv na pustej liście zwraca sam nagłówek", () => {
  const csv = productsToCsv([], FIELD_ORDER);
  assert.equal(csv, "product_url,ok,error,product_name,sku,price");
});

test("productsToExcelHtml generuje tabelę HTML rozpoznawaną przez Excel (.xls trick) z nagłówkiem i wierszami", () => {
  const html = productsToExcelHtml(SAMPLE_PRODUCTS, FIELD_ORDER);
  assert.match(html, /<html xmlns:x="urn:schemas-microsoft-com:office:excel">/);
  assert.match(html, /<th>product_name<\/th>/);
  assert.match(html, /<td>Krzesło biurowe<\/td>/);
  // 3 produkty + 1 nagłówek = 4 wiersze <tr>
  assert.equal((html.match(/<tr>/g) || []).length, 4);
});

test("productsToExcelHtml escapuje HTML w wartościach (bez wstrzyknięcia znaczników)", () => {
  const dangerous = [{ url: "https://x.pl/1", ok: true, fields: { product_name: { value: '<script>alert(1)</script> & "quoted"' } } }];
  const html = productsToExcelHtml(dangerous, ["product_name"]);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&amp;/);
  assert.match(html, /&quot;quoted&quot;/);
});

test("productsToXlsxBlob generuje prawdziwy plik XLSX jako ZIP z arkuszem", async () => {
  const blob = productsToXlsxBlob(SAMPLE_PRODUCTS, FIELD_ORDER);
  assert.equal(blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(bytes[0], 0x50); // P
  assert.equal(bytes[1], 0x4b); // K
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /\[Content_Types\]\.xml/);
  assert.match(text, /xl\/worksheets\/sheet1\.xml/);
  assert.match(text, /Krzesło biurowe/);
});

test("imagesToZipBlob pakuje wiele zdjęć (surowe bajty binarne) do jednego pliku ZIP", async () => {
  // Regresja dla "pobieranie zdjęć ma iść masowo, jednym plikiem, nie N osobnych pobrań" —
  // sidepanel/main.js woła to zamiast N wywołań chrome.downloads.download.
  const img1 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x01, 0x02, 0x03]); // fragment nagłówka JPEG + śmieciowe bajty
  const img2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb, 0xcc]); // fragment nagłówka PNG + śmieciowe bajty
  const blob = imagesToZipBlob([
    { name: "produkt-1.jpg", bytes: img1 },
    { name: "produkt-2.png", bytes: img2 },
  ]);
  assert.equal(blob.type, "application/zip");

  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(bytes[0], 0x50); // "P" — sygnatura ZIP (PK\x03\x04)
  assert.equal(bytes[1], 0x4b); // "K"

  // Metoda "store" (bez kompresji) — oryginalne bajty obu zdjęć muszą być dosłownie w archiwum.
  assert.ok(containsBytes(bytes, img1));
  assert.ok(containsBytes(bytes, img2));

  const text = new TextDecoder().decode(bytes);
  assert.match(text, /produkt-1\.jpg/);
  assert.match(text, /produkt-2\.png/);
});

test("imagesToZipBlob na pustej liście nadal zwraca poprawny (pusty) plik ZIP", async () => {
  const blob = imagesToZipBlob([]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Sam "end of central directory record" — sygnatura PK\x05\x06.
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  assert.equal(bytes[2], 0x05);
  assert.equal(bytes[3], 0x06);
});

test("normalizeImageTemplate buduje wzór z domeny z segmentem [marka] zgodny z adapter request", () => {
  assert.equal(normalizeImageTemplate("mojadomena.pl"), "https://mojadomena.pl/produkty/[marka]/[sku].[rozszerzenie]");
  assert.equal(normalizeImageTemplate("https://x.pl/img/[sku].[rozszerzenie]"), "https://x.pl/img/[sku].[rozszerzenie]");
});

test("slugifyBrand normalizuje nazwę marki do bezpiecznego segmentu ścieżki/URL-a", () => {
  assert.equal(slugifyBrand("Acme"), "acme");
  assert.equal(slugifyBrand("Łoś & Syn Sp. z o.o."), "los-syn-sp-z-o-o");
  assert.equal(slugifyBrand(""), "bez-marki");
  assert.equal(slugifyBrand(undefined), "bez-marki");
});

test("productsToAdapterRows tworzy finalną strukturę kolumn (w tym GPSR) i linki zdjN z segmentem marki", () => {
  const rows = productsToAdapterRows(SAMPLE_PRODUCTS, "mojadomena.pl");
  assert.equal(rows[0].Cena, "199.99");
  assert.equal(rows[0].SKU, "X200-BLK");
  assert.equal(rows[0].EAN, "5901234567890");
  assert.equal(rows[0].Marka, "Acme");
  assert.equal(rows[0]["TYTUŁ OFERTY"], "Krzesło biurowe");
  assert.match(rows[0].opis_dodatkowy4, /Parametry produktu/);
  assert.ok(!rows[0].OPIS.includes("<img"));
  // Segment [marka] w linku MUSI być tym samym slugiem, co folder tworzony przy pobieraniu
  // zdjęć (onExportImages w sidepanel/main.js) — inaczej link w CSV nie wskazywałby na
  // rzeczywiste miejsce pliku po wgraniu na domenę usera.
  assert.equal(rows[0].zdj1, "https://mojadomena.pl/produkty/acme/X200-BLK.jpg");
  assert.equal(rows[0].zdj2, "https://mojadomena.pl/produkty/acme/X200-BLK.png");
  assert.equal(rows[0].GPSR, "");
});

test("headersForRows dokłada dynamiczne kolumny zdjęć na końcu", () => {
  const headers = headersForRows([{ SKU: "A", zdj2: "b", zdj1: "a" }]);
  assert.deepEqual(headers.slice(-2), ["zdj1", "zdj2"]);
});

test("rowsToCsv i rowsToXlsxBlob eksportują finalne wiersze adaptera", async () => {
  const rows = productsToAdapterRows(SAMPLE_PRODUCTS, "mojadomena.pl");
  const csv = rowsToCsv(rows);
  assert.match(csv.split("\r\n")[0], /^Cena,SKU,EAN,OPIS/);
  assert.match(csv.split("\r\n")[0], /GPSR/);
  assert.match(csv, /zdj1,zdj2/);
  assert.match(csv, /https:\/\/mojadomena\.pl\/produkty\/acme\/X200-BLK\.jpg/);

  const blob = rowsToXlsxBlob(rows);
  const text = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
  assert.match(text, /TYTUŁ OFERTY/);
  assert.match(text, /https:\/\/mojadomena\.pl\/produkty\/acme\/X200-BLK\.png/);
});
