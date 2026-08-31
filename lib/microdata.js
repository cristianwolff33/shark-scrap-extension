/**
 * @file Detekcja microdata (schema.org/Product przez itemscope/itemprop). Działa na realnym DOM
 * (przyjmuje `root`, w praktyce `document`), więc nie jest jednostkowo testowana w Node —
 * weryfikacja e2e na realnych stronach, patrz docs/EXTENSION_BRIDGE.md (backlog v0.2: fixture HTML + jsdom).
 */

const ITEMPROP_MAP = {
  name: "product_name",
  sku: "sku",
  productid: "sku",
  gtin13: "ean",
  gtin: "ean",
  gtin8: "ean",
  gtin12: "ean",
  mpn: "ean",
  brand: "brand",
  price: "price",
  pricecurrency: "currency",
  availability: "availability",
  category: "category",
  description: "description",
  image: "images",
  url: "product_url",
};

function valueForItempropEl(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === "meta") return el.getAttribute("content") || "";
  if (tag === "link" || tag === "a") return el.getAttribute("href") || (el.textContent || "").trim();
  if (tag === "img" || tag === "source") return el.getAttribute("src") || el.getAttribute("content") || "";
  if (tag === "time") return el.getAttribute("datetime") || (el.textContent || "").trim();
  return (el.textContent || "").trim();
}

function elementSelectorHint(el) {
  // Lekki, "best effort" selektor do podglądu — pełny generateSelector liczony jest
  // dopiero gdy user kliknie "Select element" (picker.js), tu chodzi tylko o auto-detekcję.
  const tag = el.tagName.toLowerCase();
  const prop = el.getAttribute("itemprop");
  return `[itemprop="${prop}"]`.length ? `${tag}[itemprop="${prop}"]` : tag;
}

/** @param {Document|Element} root */
export function detectFromMicrodata(root) {
  const productScope = root.querySelector('[itemscope][itemtype*="Product" i]');
  if (!productScope) return { found: false, fields: {} };

  /** @type {Record<string, any>} */
  const fields = {};
  const propEls = productScope.querySelectorAll("[itemprop]");
  for (const el of propEls) {
    const prop = (el.getAttribute("itemprop") || "").toLowerCase();
    const field = ITEMPROP_MAP[prop];
    if (!field) continue;
    const value = valueForItempropEl(el);
    if (!value) continue;
    if (fields[field] && field !== "images") continue; // pierwsze trafienie wygrywa (poza multi-value)
    if (field === "images") {
      fields.images = fields.images || { source: "microdata", selector: `[itemscope][itemtype*="Product" i] [itemprop="image"]`, attr: "src", multiple: true, value };
      continue;
    }
    fields[field] = {
      source: "microdata",
      selector: elementSelectorHint(el),
      attr: el.tagName.toLowerCase() === "meta" ? "content" : el.tagName.toLowerCase() === "a" || el.tagName.toLowerCase() === "link" ? "href" : "text",
      multiple: false,
      value,
    };
  }

  return { found: Object.keys(fields).length > 0, fields };
}
