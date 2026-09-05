import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFieldSources, missingFields, pickRichestImagesField } from "../lib/fields.js";

test("mergeFieldSources: wyższy priorytet nadpisuje niższy", () => {
  const jsonld = { price: { source: "jsonld", value: "100" } };
  const dom = { price: { source: "dom", value: "999" }, brand: { source: "dom", value: "Acme" } };
  const merged = mergeFieldSources({}, jsonld, {}, {}, dom);
  assert.equal(merged.price.source, "jsonld");
  assert.equal(merged.price.value, "100");
  assert.equal(merged.brand.source, "dom");
});

test("mergeFieldSources: ręczny wybór (manual) zawsze wygrywa", () => {
  const jsonld = { price: { source: "jsonld", value: "100" } };
  const manual = { price: { source: "css", value: "123", selector: "#p" } };
  const merged = mergeFieldSources(manual, jsonld);
  assert.equal(merged.price.source, "css");
  assert.equal(merged.price.value, "123");
});

test("missingFields zwraca pola bez wartości", () => {
  const merged = { sku: { value: "A1" }, price: { value: "" } };
  const result = missingFields(["sku", "price", "brand"], merged);
  assert.deepEqual(result, ["price", "brand"]);
});

test("pickRichestImagesField: pełna galeria z DOM (kilka zdjęć) wygrywa z pojedynczym og:image z meta, mimo niższego priorytetu źródła", () => {
  // Realny przypadek: og:image (meta) generuje JEDNO zdjęcie pod social sharing (często
  // mniejsze), a prawdziwa galeria produktu w DOM ma kilka zdjęć w pełnej rozdzielczości.
  // Ślepe trzymanie się priorytetu jsonld>microdata>meta>dom oznaczałoby, że to jedno małe
  // zdjęcie ZAWSZE wygrywa.
  const metaImages = { source: "meta", multiple: true, value: "https://sklep.pl/og-image-small.jpg" };
  const domImages = {
    source: "dom",
    multiple: true,
    value: "https://sklep.pl/produkt-1.webp",
    values: ["https://sklep.pl/produkt-1.webp", "https://sklep.pl/produkt-2.webp", "https://sklep.pl/produkt-3.webp"],
  };
  const result = pickRichestImagesField([undefined, undefined, metaImages, domImages]);
  assert.equal(result, domImages);
});

test("pickRichestImagesField: przy remisie liczby zdjęć wygrywa wcześniejszy w kolejności (oryginalny priorytet źródeł jako tiebreaker)", () => {
  const jsonldImages = { source: "jsonld", value: "a.jpg" };
  const domImages = { source: "dom", value: "b.jpg" };
  assert.equal(pickRichestImagesField([jsonldImages, undefined, undefined, domImages]), jsonldImages);
});

test("pickRichestImagesField pomija brakujące/puste kandydatury i zwraca null gdy nic nie ma", () => {
  assert.equal(pickRichestImagesField([undefined, null, undefined]), null);
  assert.equal(pickRichestImagesField([]), null);
  const only = { source: "dom", values: ["x.jpg"] };
  assert.equal(pickRichestImagesField([undefined, only, undefined]), only);
});
