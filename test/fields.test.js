import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFieldSources, missingFields } from "../lib/fields.js";

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
