import { test } from "node:test";
import assert from "node:assert/strict";
import { mapOgTags } from "../lib/meta.js";

test("mapOgTags mapuje standardowe znaczniki OpenGraph/product", () => {
  const fields = mapOgTags([
    ["og:title", "Krzesło X200"],
    ["product:price:amount", "499.00"],
    ["product:price:currency", "PLN"],
    ["og:image", "https://cdn.example.com/x.jpg"],
    ["unrelated:tag", "ignoruj mnie"],
  ]);
  assert.equal(fields.product_name.value, "Krzesło X200");
  assert.equal(fields.price.value, "499.00");
  assert.equal(fields.currency.value, "PLN");
  assert.equal(fields.images.multiple, true);
  assert.equal(fields.unrelated, undefined);
});

test("mapOgTags: pierwsze trafienie wygrywa przy duplikatach", () => {
  const fields = mapOgTags([
    ["og:title", "Pierwszy"],
    ["og:title", "Drugi"],
  ]);
  assert.equal(fields.product_name.value, "Pierwszy");
});
