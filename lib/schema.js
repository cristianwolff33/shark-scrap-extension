/**
 * @file Współdzielony kontrakt danych między rozszerzeniem a bridgem (bridge/schemas.py).
 * Zmiana pól tutaj MUSI być odzwierciedlona w bridge/schemas.py — to jest jedyne
 * źródło prawdy dla kształtu JSON-a zapisywanego per domena.
 */

export const SCHEMA_VERSION = 1;

/** Kolejność źródeł wg priorytetu automatycznej detekcji (najpierw wygrywa). */
export const FIELD_SOURCES = /** @type {const} */ ([
  "jsonld",
  "microdata",
  "meta",
  "dom",
  "css", // ręcznie wskazany selektor (picker) lub dopasowanie DOM-heurystyką
  "canonical",
  "ai", // fallback modelu dla pól, których nic powyższego nie znalazło — local/dev OpenAI albo Cloud AI API
]);

/** Lista pól produktowych obsługiwanych przez MVP (zgodnie ze specyfikacją). */
export const PRODUCT_FIELDS = /** @type {const} */ ([
  "product_name",
  "sku",
  "ean",
  "brand",
  "price",
  "old_price",
  "currency",
  "availability",
  "category",
  "description",
  "images",
  "product_url",
  "variants",
]);

/** Pola bez potwierdzonego odpowiednika w modelu Product zamkniętego core'u —
 * generator adaptera umieszcza je w `metadata` (patrz bridge/adapter_generator.py). */
export const UNMAPPED_CORE_FIELDS = /** @type {const} */ ([
  "old_price",
  "availability",
  "product_url",
  "variants",
]);

/**
 * @typedef {Object} FieldSpec
 * @property {string} source - jedna z FIELD_SOURCES
 * @property {string} [path]      - ścieżka w obiekcie JSON-LD, np. "offers.price"
 * @property {string} [selector]  - selektor CSS (source: css/dom)
 * @property {string} [name]      - nazwa meta/property (source: meta)
 * @property {string} [attr]      - "text" | "html" | nazwa atrybutu HTML (np. "src", "content")
 * @property {boolean} [multiple] - czy zbierać wiele elementów (np. images, variants)
 * @property {boolean} [experimental]
 * @property {string} [value]     - podgląd ostatnio wykrytej wartości (tylko UI, nie wysyłane do bridge)
 */

/**
 * @typedef {Object} PaginationSpec
 * @property {"none"|"next_link"|"load_more"|"infinite_scroll"} mode
 * @property {string} [next_selector]
 * @property {string} [load_more_selector]
 * @property {number} [max_pages]
 * @property {boolean} experimental
 */

/**
 * @typedef {Object} ListPageSpec
 * @property {boolean} enabled
 * @property {string} [item_selector]
 * @property {string} [url_selector]
 * @property {string} [url_attribute]
 * @property {number} [detected_count]
 * @property {PaginationSpec} pagination
 */

/**
 * @typedef {Object} ScraperConfig
 * @property {number} schema_version
 * @property {string} domain
 * @property {string} start_url
 * @property {"requests"|"playwright"|"api"|"xml"|"csv"} mode
 * @property {{name: string, base_url: string}} source
 * @property {ListPageSpec} list_page
 * @property {Record<string, FieldSpec>} fields
 * @property {{public_base_url: string, brand_segment: string}} image_links
 * @property {string} notes
 * @property {string} [generated_at]
 */

/**
 * @typedef {Object} FileInfo
 * @property {string} name
 * @property {string} path
 * @property {number} size
 * @property {string} modified_at
 * @property {string} [download_url]
 */

/**
 * @typedef {Object} OutputsOut
 * @property {FileInfo[]} csv
 * @property {FileInfo[]} excel
 * @property {string[]} image_dirs
 * @property {string} note
 * @property {string} [zip_download_url]
 */

/** @returns {ScraperConfig} */
export function createDefaultConfig(domain, startUrl) {
  return {
    schema_version: SCHEMA_VERSION,
    domain,
    start_url: startUrl,
    mode: "requests",
    source: { name: slugifyDomain(domain), base_url: `https://${domain}` },
    list_page: {
      enabled: false,
      item_selector: "",
      url_selector: "",
      url_attribute: "href",
      pagination: { mode: "none", next_selector: "", load_more_selector: "", max_pages: 20, experimental: false },
    },
    fields: {},
    image_links: { public_base_url: "", brand_segment: "" },
    notes: "",
  };
}

/** Zamienia domenę na bezpieczny slug używany jako --name adaptera. */
export function slugifyDomain(domain) {
  return String(domain || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "sklep";
}
