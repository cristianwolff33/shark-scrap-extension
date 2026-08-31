/**
 * @file Czysta logika parsowania JSON-LD (schema.org/Product). Zero zależności od DOM/chrome —
 * wejściem jest tablica surowych stringów z <script type="application/ld+json">, wyjściem
 * kandydaci na węzły Product oraz mapowanie pól na ścieżki (path), które da się później
 * odtworzyć po stronie Pythona (scraping_kit.extraction.get_by_path) na stronach produktowych.
 */

/** @param {string[]} rawStrings */
export function parseJsonLdBlocks(rawStrings) {
  /** @type {any[]} */
  const nodes = [];
  for (const raw of rawStrings) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // niepoprawny JSON — pomijamy, nie wywalamy detekcji całej strony
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      flattenGraph(item, nodes);
    }
  }
  return nodes;
}

function flattenGraph(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node["@graph"])) {
    for (const child of node["@graph"]) flattenGraph(child, out);
    return;
  }
  out.push(node);
  // Niektóre sklepy zagnieżdżają Product w mainEntity/itemListElement.
  if (node.mainEntity) flattenGraph(node.mainEntity, out);
  if (Array.isArray(node.itemListElement)) {
    for (const child of node.itemListElement) flattenGraph(child?.item ?? child, out);
  }
}

function typeIncludes(node, typeName) {
  const t = node?.["@type"];
  if (!t) return false;
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => String(x).toLowerCase() === typeName.toLowerCase());
}

/** Zwraca węzły @type Product znalezione we wszystkich blokach JSON-LD strony. */
export function findProductNodes(nodes) {
  return nodes.filter((n) => typeIncludes(n, "Product"));
}

/** Prosty resolver ścieżek kropkowanych z obsługą indeksu tablicy, np. "offers.0.price". */
export function getByPath(obj, path) {
  if (!path) return undefined;
  return path.split(".").reduce((acc, key) => {
    if (acc === undefined || acc === null) return undefined;
    return acc[key];
  }, obj);
}

function firstOffer(node) {
  const offers = node.offers;
  if (!offers) return { value: undefined, prefix: "offers" };
  if (Array.isArray(offers)) return { value: offers[0], prefix: "offers.0" };
  return { value: offers, prefix: "offers" };
}

const GTIN_KEYS = ["gtin13", "gtin", "gtin8", "gtin12", "isbn"];

/**
 * Mapuje jeden węzeł Product na pola MVP. Zwraca obiekt {field: {source:'jsonld', path, attr, multiple, value}}.
 * Świadomie NIE zgaduje `old_price` z JSON-LD — standard schema.org go nie definiuje jednoznacznie,
 * więc to pole zostaje puste do ręcznego wskazania przez picker.
 */
export function mapProductNode(node) {
  /** @type {Record<string, any>} */
  const fields = {};
  const set = (field, path, attr, multiple, value) => {
    if (value === undefined || value === null || value === "") return;
    fields[field] = { source: "jsonld", path, attr: attr ?? "value", multiple: !!multiple, value };
  };

  set("product_name", "name", "value", false, node.name);
  set("sku", "sku", "value", false, node.sku ?? node.mpn);
  if (node.sku === undefined && node.mpn !== undefined) fields.sku && (fields.sku.path = "mpn");

  for (const key of GTIN_KEYS) {
    if (node[key] !== undefined && node[key] !== "") {
      set("ean", key, "value", false, node[key]);
      break;
    }
  }

  const brand = node.brand;
  if (typeof brand === "string") set("brand", "brand", "value", false, brand);
  else if (brand && typeof brand === "object") set("brand", "brand.name", "value", false, brand.name);

  const { value: offer, prefix } = firstOffer(node);
  if (offer && typeof offer === "object") {
    set("price", `${prefix}.price`, "value", false, offer.price);
    set("currency", `${prefix}.priceCurrency`, "value", false, offer.priceCurrency);
    set("availability", `${prefix}.availability`, "value", false, offer.availability);
  }

  const category = Array.isArray(node.category) ? node.category[0] : node.category;
  set("category", Array.isArray(node.category) ? "category.0" : "category", "value", false, category);

  set("description", "description", "value", false, node.description);

  if (node.image !== undefined) {
    const rawList = Array.isArray(node.image) ? node.image : [node.image];
    const urls = rawList.map((im) => (im && typeof im === "object" ? im.url : im)).filter(Boolean);
    if (urls.length > 0) {
      set("images", "image", "value", true, urls[0]);
      // `values` (pełna lista, nie tylko podgląd) — używane przez przycisk "Zdjęcia" w prostym
      // trybie (sidepanel/main.js) do pobrania WSZYSTKICH zdjęć produktu, nie tylko pierwszego.
      if (fields.images) fields.images.values = urls;
    }
  }

  set("product_url", node.url ? "url" : "@id", "value", false, node.url ?? node["@id"]);

  if (Array.isArray(node.offers) && node.offers.length > 1) {
    fields.variants = { source: "jsonld", path: "offers", attr: "value", multiple: true, value: `${node.offers.length} wariant(ów)` };
  } else if (node.hasVariant) {
    const count = Array.isArray(node.hasVariant) ? node.hasVariant.length : 1;
    fields.variants = { source: "jsonld", path: "hasVariant", attr: "value", multiple: true, value: `${count} wariant(ów)` };
  }

  return fields;
}

/** Punkt wejścia używany przez content/detector.js. */
export function detectFromJsonLd(rawStrings) {
  const nodes = parseJsonLdBlocks(rawStrings);
  const products = findProductNodes(nodes);
  if (products.length === 0) return { found: false, fields: {} };
  // Bierzemy pierwszy pasujący węzeł — strony produktowe zwykle mają jeden Product.
  return { found: true, fields: mapProductNode(products[0]) };
}
