import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonLdBlocks, findProductNodes, mapProductNode, getByPath, detectFromJsonLd } from "../lib/jsonld.js";

const PRODUCT = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Krzesło biurowe X200",
  sku: "X200-BLK",
  gtin13: "5901234123457",
  brand: { "@type": "Brand", name: "Acme" },
  category: "Meble > Krzesła biurowe",
  description: "Ergonomiczne krzesło biurowe.",
  image: ["https://cdn.example.com/x200-1.jpg", "https://cdn.example.com/x200-2.jpg"],
  url: "https://sklep.pl/produkt/x200",
  offers: { "@type": "Offer", price: "499.00", priceCurrency: "PLN", availability: "https://schema.org/InStock" },
};

test("mapProductNode wyciąga podstawowe pola i ścieżki", () => {
  const fields = mapProductNode(PRODUCT);
  assert.equal(fields.product_name.value, "Krzesło biurowe X200");
  assert.equal(fields.product_name.path, "name");
  assert.equal(fields.sku.value, "X200-BLK");
  assert.equal(fields.ean.value, "5901234123457");
  assert.equal(fields.ean.path, "gtin13");
  assert.equal(fields.brand.value, "Acme");
  assert.equal(fields.brand.path, "brand.name");
  assert.equal(fields.price.value, "499.00");
  assert.equal(fields.price.path, "offers.price");
  assert.equal(fields.currency.value, "PLN");
  assert.equal(fields.availability.value, "https://schema.org/InStock");
  assert.equal(fields.images.multiple, true);
  assert.equal(fields.images.value, "https://cdn.example.com/x200-1.jpg"); // pierwsze = podgląd
  assert.deepEqual(fields.images.values, ["https://cdn.example.com/x200-1.jpg", "https://cdn.example.com/x200-2.jpg"]); // pełna lista do pobrania wszystkich zdjęć
  assert.equal(fields.product_url.value, "https://sklep.pl/produkt/x200");
});

test("mapProductNode: pojedynczy obiekt image (nie tablica) trafia do values jako lista jednoelementowa", () => {
  const single = { ...PRODUCT, image: "https://cdn.example.com/only.jpg" };
  const fields = mapProductNode(single);
  assert.equal(fields.images.value, "https://cdn.example.com/only.jpg");
  assert.deepEqual(fields.images.values, ["https://cdn.example.com/only.jpg"]);
});

test("ścieżki wygenerowane przez mapProductNode odtwarzają wartość przez getByPath (spójność z Pythonem)", () => {
  const fields = mapProductNode(PRODUCT);
  for (const [field, spec] of Object.entries(fields)) {
    if (field === "images" || field === "variants") continue; // wielowartościowe — inna ścieżka odczytu
    assert.equal(getByPath(PRODUCT, spec.path), spec.value, `field ${field}`);
  }
});

test("obsługuje @graph i pomija niepoprawny JSON bez wyjątku", () => {
  const raw = [
    "{not valid json",
    JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "WebPage" }, PRODUCT] }),
  ];
  const result = detectFromJsonLd(raw);
  assert.equal(result.found, true);
  assert.equal(result.fields.sku.value, "X200-BLK");
});

test("offers jako tablica > 1 elementów oznacza warianty", () => {
  const withVariants = { ...PRODUCT, offers: [{ price: "10" }, { price: "12" }, { price: "15" }] };
  const fields = mapProductNode(withVariants);
  assert.equal(fields.variants.multiple, true);
  assert.match(fields.variants.value, /3/);
});

test("brak węzła Product zwraca found:false", () => {
  const result = detectFromJsonLd([JSON.stringify({ "@type": "WebSite", name: "x" })]);
  assert.equal(result.found, false);
  assert.deepEqual(result.fields, {});
});

test("findProductNodes ignoruje inne typy", () => {
  const nodes = parseJsonLdBlocks([JSON.stringify([{ "@type": "BreadcrumbList" }, PRODUCT])]);
  assert.equal(findProductNodes(nodes).length, 1);
});
