/**
 * @file Shopify ma publiczne, nieautoryzowane Storefront JSON API dla KAŻDEGO produktu — wystarczy
 * dopisać ".json" do URL-a strony produktu (np. .../products/koszulka -> .../products/koszulka.json),
 * żeby dostać kompletne, ustrukturyzowane dane: tytuł, markę (vendor), opis, WSZYSTKIE zdjęcia i,
 * co najważniejsze, PEŁNĄ listę wariantów z osobnym sku/ceną/dostępnością każdego — czego JSON-LD
 * większości Shopify-owych themów w ogóle nie eksponuje (zwykle tylko zakres cen).
 *
 * To NIE jest scraping w sensie parsowania HTML-a — to udokumentowane, publiczne API sklepu,
 * dokładnie tak samo dostępne każdemu odwiedzającemu stronę produktu w przeglądarce.
 *
 * Wykrywanie Shopify jest heurystyczne (kilka niezależnych sygnałów w HTML-u) — jeśli żaden nie
 * pasuje, po prostu nie próbujemy dobudować ".json" (uniknięcie zbędnego requestu na nie-Shopify).
 */

const SHOPIFY_SIGNAL_RE = /cdn\.shopify\.com|shopify\.theme|window\.Shopify\s*=|Shopify\.shop\s*=/i;

/** @param {string} html */
export function looksLikeShopify(html) {
  return SHOPIFY_SIGNAL_RE.test(String(html || ""));
}

/** Buduje URL do Storefront JSON API danej strony produktu, albo null gdy URL nie wygląda na produkt Shopify. */
export function shopifyProductJsonUrl(productUrl) {
  try {
    const u = new URL(productUrl);
    if (!/\/products\/[^/]+\/?$/.test(u.pathname)) return null;
    u.pathname = u.pathname.replace(/\/+$/, "") + ".json";
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Mapuje odpowiedź Storefront JSON (`{ product: {...} }`) na pola MVP + PEŁNE warianty
 * (fields.variants.values, nie tylko licznik — patrz też lib/jsonld.js summarizeOffer, ten sam
 * kształt {name, sku, price, priceCurrency, availability}, żeby eksport/UI nie musiały znać
 * różnicy między źródłem jsonld a shopify).
 * @param {any} payload
 */
export function mapShopifyProduct(payload) {
  const product = payload?.product;
  if (!product || typeof product !== "object") return null;

  /** @type {Record<string, any>} */
  const fields = {};
  const set = (field, value, multiple) => {
    if (value === undefined || value === null || value === "") return;
    fields[field] = { source: "shopify", attr: "value", multiple: !!multiple, value };
  };

  set("product_name", product.title);
  set("brand", product.vendor);
  set("category", product.product_type);
  set("description", stripHtml(product.body_html));

  const variants = Array.isArray(product.variants) ? product.variants : [];
  const currency = product.currency || ""; // Storefront JSON zwykle nie ma priceCurrency wprost przy variancie
  const firstAvailable = variants.find((v) => v?.available) || variants[0];
  if (firstAvailable) {
    set("sku", firstAvailable.sku);
    set("price", firstAvailable.price);
    set("availability", firstAvailable.available === false ? "Niedostępny" : "Dostępny");
  }
  if (variants.length > 1) {
    fields.variants = {
      source: "shopify",
      attr: "value",
      multiple: true,
      value: `${variants.length} wariant(ów)`,
      values: variants.map((v, i) => ({
        name: v?.title || `Wariant ${i + 1}`,
        sku: String(v?.sku || ""),
        price: String(v?.price ?? ""),
        priceCurrency: currency,
        availability: v?.available === false ? "Niedostępny" : "Dostępny",
      })),
    };
  }

  const images = Array.isArray(product.images) ? product.images.map((img) => img?.src).filter(Boolean) : [];
  if (images.length > 0) {
    fields.images = { source: "shopify", attr: "src", multiple: true, value: images[0], values: images };
  }

  return fields;
}
