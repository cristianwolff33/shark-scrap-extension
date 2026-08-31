import { test } from "node:test";
import assert from "node:assert/strict";
import { productsToPlainRows, productsToCsv, productsToExcelHtml, productsToXlsxBlob } from "../lib/export.js";

const FIELD_ORDER = ["product_name", "sku", "price"];

const SAMPLE_PRODUCTS = [
  {
    url: "https://sklep.pl/p/1",
    ok: true,
    fields: {
      product_name: { value: "Krzesło biurowe" },
      sku: { value: "X200-BLK" },
      price: { value: "199.99" },
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
