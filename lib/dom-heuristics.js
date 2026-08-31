/**
 * @file Ostatnia linia detekcji: typowe wzorce DOM używane w polskich/europejskich sklepach
 * e-commerce, gdy strona nie ma JSON-LD ani microdata (albo brakuje w nich pola).
 * Lista kandydatów jest świadomie krótka i skupiona na e-commerce — to NIE jest generyczny
 * web scraper (patrz ograniczenia w specyfikacji MVP).
 */

/** @type {Record<string, string[]>} */
export const CANDIDATE_SELECTORS = {
  product_name: ["h1.product-title", "h1[itemprop=name]", "h1.product-name", "h1"],
  price: [
    "[itemprop=price]",
    ".price .amount",
    ".product-price .price",
    ".price--current",
    ".price:not(.price--old)",
    "span.price",
  ],
  old_price: [".price--old", ".price-old", "del.price", "s.price", ".product-price__old"],
  sku: ["[itemprop=sku]", ".product-sku", ".sku-value", "[data-sku]"],
  ean: ["[itemprop=gtin13]", ".product-ean", "[data-ean]"],
  brand: ["[itemprop=brand]", ".product-brand", ".brand-name", "a.brand"],
  availability: [".stock-status", ".availability", ".product-availability", "[data-availability]"],
  description: ["#description", ".product-description", "[itemprop=description]", ".product-details__description"],
  category: ["nav.breadcrumb", "ol.breadcrumb", ".breadcrumbs", '[aria-label="breadcrumb" i]'],
};

export const IMAGE_GALLERY_SELECTORS = [
  ".product-gallery img",
  ".product-images img",
  "[data-gallery] img",
  ".gallery img",
  "picture img",
];

/**
 * Próbuje kolejnych selektorów dla danego pola, zwraca pierwszy niepusty wynik.
 * @param {Document|Element} root
 * @param {(el: Element) => string} readValue
 */
function firstMatch(root, selectors, readValue) {
  for (const selector of selectors) {
    try {
      const el = root.querySelector(selector);
      if (!el) continue;
      const value = readValue(el);
      if (value) return { selector, value, el };
    } catch {
      // nieprawidłowy selektor w danym silniku CSS — pomijamy
    }
  }
  return null;
}

function textOf(el) {
  return (el.textContent || "").trim();
}

/** @param {Document|Element} root */
export function detectFromDom(root) {
  /** @type {Record<string, any>} */
  const fields = {};

  for (const [field, selectors] of Object.entries(CANDIDATE_SELECTORS)) {
    if (field === "category") {
      const match = firstMatch(root, selectors, (el) => {
        const links = el.querySelectorAll ? el.querySelectorAll("a") : [];
        return Array.from(links).map((a) => textOf(a)).filter(Boolean).join(" > ");
      });
      if (match) {
        fields.category = { source: "dom", selector: `${match.selector} a`, attr: "text", multiple: true, value: match.value };
      }
      continue;
    }
    const match = firstMatch(root, selectors, textOf);
    if (match) {
      fields[field] = { source: "dom", selector: match.selector, attr: "text", multiple: false, value: match.value };
    }
  }

  const gallery = firstMatch(root, IMAGE_GALLERY_SELECTORS, (el) => el.getAttribute("src") || el.getAttribute("data-src") || "");
  if (gallery) {
    fields.images = { source: "dom", selector: gallery.selector, attr: "src", multiple: true, value: gallery.value, values: allImageUrls(root) };
  }

  return { found: Object.keys(fields).length > 0, fields };
}

/**
 * Zbiera WSZYSTKIE (nie tylko pierwszy) adresy zdjęć pasujące do znanych selektorów galerii —
 * używane przez przycisk "Zdjęcia" w prostym trybie (sidepanel/main.js), żeby pobrać cały
 * zestaw zdjęć produktu, nie tylko podgląd. Deduplikowane, bez twardego limitu tutaj (limit
 * bezpieczeństwa jest w main.js na poziomie całego skanu).
 * @param {Document|Element} root
 */
export function allImageUrls(root) {
  const seen = new Set();
  const out = [];
  for (const selector of IMAGE_GALLERY_SELECTORS) {
    let els;
    try {
      els = root.querySelectorAll ? root.querySelectorAll(selector) : [];
    } catch {
      continue;
    }
    for (const el of els) {
      const url = el.getAttribute("src") || el.getAttribute("data-src") || "";
      if (url && !seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    }
  }
  return out;
}
