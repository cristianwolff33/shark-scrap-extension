import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonLdBlocks,
  findProductNodes,
  findBreadcrumbListNodes,
  breadcrumbListToCategoryPath,
  mapProductNode,
  getByPath,
  detectFromJsonLd,
} from "../lib/jsonld.js";

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
  // "https://schema.org/InStock" -> zamieniane na czytelny polski tekst, nie zostaje surowym URL-em w eksporcie.
  assert.equal(fields.availability.value, "Dostępny");
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
    if (field === "availability") continue; // wartość jest humanizowana (patrz test niżej), nie 1:1 z surowym schema.org
    assert.equal(getByPath(PRODUCT, spec.path), spec.value, `field ${field}`);
  }
});

test("mapProductNode humanizuje availability ze schema.org (URL albo skrót) na czytelny tekst", () => {
  const cases = [
    ["https://schema.org/InStock", "Dostępny"],
    ["OutOfStock", "Niedostępny"],
    ["https://schema.org/PreOrder", "Przedsprzedaż"],
    ["LimitedAvailability", "Ograniczona dostępność"],
  ];
  for (const [raw, expected] of cases) {
    const fields = mapProductNode({ ...PRODUCT, offers: { ...PRODUCT.offers, availability: raw } });
    assert.equal(fields.availability.value, expected, `raw=${raw}`);
  }
  // Nieznana/nietypowa wartość — zostaje bez zmian (nie ucinamy informacji, której nie rozumiemy).
  const unknown = mapProductNode({ ...PRODUCT, offers: { ...PRODUCT.offers, availability: "SomeWeirdStatus" } });
  assert.equal(unknown.availability.value, "SomeWeirdStatus");
});

test("findBreadcrumbListNodes i breadcrumbListToCategoryPath budują ścieżkę kategorii z okruszków SEO", () => {
  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 2, name: "Krzesła biurowe" },
      { "@type": "ListItem", position: 1, name: "Meble" },
      { "@type": "ListItem", position: 3, item: { name: "X200" } },
    ],
  };
  const nodes = parseJsonLdBlocks([JSON.stringify(breadcrumb)]);
  const found = findBreadcrumbListNodes(nodes);
  assert.equal(found.length, 1);
  assert.equal(breadcrumbListToCategoryPath(found[0]), "Meble > Krzesła biurowe > X200");
});

test("detectFromJsonLd spada na BreadcrumbList, gdy węzeł Product nie ma własnej category", () => {
  const productWithoutCategory = { ...PRODUCT };
  delete productWithoutCategory.category;
  const breadcrumb = {
    "@type": "BreadcrumbList",
    itemListElement: [
      { position: 1, name: "Meble" },
      { position: 2, name: "Krzesła biurowe" },
    ],
  };
  const result = detectFromJsonLd([JSON.stringify(productWithoutCategory), JSON.stringify(breadcrumb)]);
  assert.equal(result.fields.category.value, "Meble > Krzesła biurowe");
  assert.equal(result.fields.category.source, "jsonld");
});

test("detectFromJsonLd NIE nadpisuje category z Product breadcrumbem, jeśli Product już ją ma", () => {
  const breadcrumb = { "@type": "BreadcrumbList", itemListElement: [{ position: 1, name: "Coś innego" }] };
  const result = detectFromJsonLd([JSON.stringify(PRODUCT), JSON.stringify(breadcrumb)]);
  assert.equal(result.fields.category.value, "Meble > Krzesła biurowe"); // z samego Product, nie z breadcrumb
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

test("offers[] z sku/price/availability per wariant trafiają do fields.variants.values (nie tylko licznik)", () => {
  const withVariants = {
    ...PRODUCT,
    offers: [
      { name: "Rozmiar S", sku: "X200-S", price: "199.00", priceCurrency: "PLN", availability: "https://schema.org/InStock" },
      { name: "Rozmiar M", sku: "X200-M", price: "199.00", priceCurrency: "PLN", availability: "OutOfStock" },
      { sku: "X200-L", price: "219.00" }, // bez name/availability — nie powinno wywrócić reszty
    ],
  };
  const fields = mapProductNode(withVariants);
  assert.equal(fields.variants.values.length, 3);
  assert.deepEqual(fields.variants.values[0], { name: "Rozmiar S", sku: "X200-S", price: "199.00", priceCurrency: "PLN", availability: "Dostępny" });
  assert.equal(fields.variants.values[1].availability, "Niedostępny");
  assert.equal(fields.variants.values[2].name, "Wariant 3"); // fallback nazwy gdy brak name
  assert.equal(fields.variants.values[2].sku, "X200-L");
});

test("hasVariant (tablica Product/wariantów) też buduje pełne fields.variants.values", () => {
  const withHasVariant = {
    ...PRODUCT,
    offers: undefined,
    hasVariant: [
      { name: "Czerwony", sku: "X200-RED", offers: { price: "199.00", priceCurrency: "PLN" } },
      { name: "Niebieski", sku: "X200-BLU", offers: { price: "209.00", priceCurrency: "PLN" } },
    ],
  };
  const fields = mapProductNode(withHasVariant);
  assert.equal(fields.variants.path, "hasVariant");
  assert.equal(fields.variants.values.length, 2);
  assert.equal(fields.variants.values[0].sku, "X200-RED");
  assert.equal(fields.variants.values[1].price, "209.00");
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
