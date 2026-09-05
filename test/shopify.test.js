import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeShopify, shopifyProductJsonUrl, mapShopifyProduct } from "../lib/shopify.js";

test("looksLikeShopify rozpoznaje popularne sygnały Shopify w HTML-u", () => {
  assert.ok(looksLikeShopify('<script src="https://cdn.shopify.com/s/files/1/x.js"></script>'));
  assert.ok(looksLikeShopify("<script>window.Shopify = {locale:'pl'};</script>"));
  assert.equal(looksLikeShopify("<html><body>zwykły sklep</body></html>"), false);
  assert.equal(looksLikeShopify(""), false);
});

test("shopifyProductJsonUrl dobudowuje .json tylko dla URL-i /products/<handle>", () => {
  assert.equal(shopifyProductJsonUrl("https://sklep.pl/products/koszulka"), "https://sklep.pl/products/koszulka.json");
  assert.equal(shopifyProductJsonUrl("https://sklep.pl/products/koszulka/"), "https://sklep.pl/products/koszulka.json");
  assert.equal(shopifyProductJsonUrl("https://sklep.pl/products/koszulka?variant=123"), "https://sklep.pl/products/koszulka.json");
  assert.equal(shopifyProductJsonUrl("https://sklep.pl/kolekcje/koszulki"), null);
  assert.equal(shopifyProductJsonUrl("nie-url"), null);
});

test("mapShopifyProduct mapuje podstawowe pola i PEŁNE warianty (sku/cena/dostępność każdy)", () => {
  const payload = {
    product: {
      title: "Koszulka Classic",
      vendor: "Acme",
      product_type: "Odzież",
      body_html: "<p>Wygodna <b>koszulka</b> bawełniana.</p>",
      currency: "PLN",
      variants: [
        { title: "S", sku: "KOSZ-S", price: "49.00", available: true },
        { title: "M", sku: "KOSZ-M", price: "49.00", available: false },
        { title: "L", sku: "KOSZ-L", price: "54.00", available: true },
      ],
      images: [{ src: "https://cdn.shopify.com/1.jpg" }, { src: "https://cdn.shopify.com/2.jpg" }],
    },
  };
  const fields = mapShopifyProduct(payload);
  assert.equal(fields.product_name.value, "Koszulka Classic");
  assert.equal(fields.brand.value, "Acme");
  assert.equal(fields.category.value, "Odzież");
  assert.equal(fields.description.value, "Wygodna koszulka bawełniana.");
  // Pierwszy DOSTĘPNY wariant reprezentuje produkt jako całość (sku/price/availability).
  assert.equal(fields.sku.value, "KOSZ-S");
  assert.equal(fields.price.value, "49.00");
  assert.equal(fields.availability.value, "Dostępny");
  // Pełne warianty, nie licznik.
  assert.equal(fields.variants.values.length, 3);
  assert.deepEqual(fields.variants.values[0], { name: "S", sku: "KOSZ-S", price: "49.00", priceCurrency: "PLN", availability: "Dostępny" });
  assert.equal(fields.variants.values[1].availability, "Niedostępny");
  assert.deepEqual(fields.images.values, ["https://cdn.shopify.com/1.jpg", "https://cdn.shopify.com/2.jpg"]);
});

test("mapShopifyProduct: gdy WSZYSTKIE warianty są niedostępne, i tak bierze pierwszy (żeby sku/price nie zostały puste)", () => {
  const payload = { product: { title: "X", variants: [{ sku: "A", price: "10", available: false }] } };
  const fields = mapShopifyProduct(payload);
  assert.equal(fields.sku.value, "A");
  assert.equal(fields.availability.value, "Niedostępny");
  assert.equal(fields.variants, undefined); // tylko 1 wariant = nie ma sensu jako "warianty"
});

test("mapShopifyProduct zwraca null na brak/niepoprawny payload", () => {
  assert.equal(mapShopifyProduct({}), null);
  assert.equal(mapShopifyProduct(null), null);
  assert.equal(mapShopifyProduct({ product: null }), null);
});
