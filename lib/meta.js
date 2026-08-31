/**
 * @file Mapowanie meta/OpenGraph → pola produktowe. Czysta funkcja: wejściem jest lista
 * par [name-lub-property, content] wyciągnięta przez detector.js z document.querySelectorAll('meta').
 */

const OG_MAP = {
  "og:title": "product_name",
  "product:brand": "brand",
  "og:price:amount": "price",
  "product:price:amount": "price",
  "og:price:currency": "currency",
  "product:price:currency": "currency",
  "og:availability": "availability",
  "product:availability": "availability",
  "og:description": "description",
  "og:image": "images",
  "og:url": "product_url",
  "product:retailer_item_id": "sku",
  "product:retailer_part_no": "sku",
  "product:sku": "sku",
  "product:ean": "ean",
  "product:gtin": "ean",
  "product:category": "category",
};

/** @param {[string, string][]} pairs */
export function mapOgTags(pairs) {
  /** @type {Record<string, any>} */
  const fields = {};
  for (const [rawName, content] of pairs) {
    if (!rawName || content === undefined || content === null || content === "") continue;
    const name = rawName.toLowerCase().trim();
    const field = OG_MAP[name];
    if (!field) continue;
    // Nie nadpisujemy — pierwsze trafienie (kolejność w dokumencie) wygrywa dla stabilności.
    if (fields[field]) continue;
    fields[field] = {
      source: "meta",
      name: rawName,
      attr: "content",
      multiple: field === "images",
      value: content,
    };
  }
  return fields;
}
