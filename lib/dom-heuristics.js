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
 * Selektory bezpośrednie dla bloku GPSR (General Product Safety Regulation, obowiązkowy od
 * 13.12.2024 w UE) — część sklepów oznacza go dedykowaną klasą/atrybutem/id.
 */
export const GPSR_SELECTORS = [
  ".gpsr-info",
  ".gpsr",
  "[class*='gpsr' i]",
  "[id*='gpsr' i]",
  "[data-gpsr]",
];

/**
 * Dopasowuje nagłówek/etykietę sekcji GPSR — hasło "GPSR" wprost, albo jego polskie opisowe
 * warianty ("informacje o bezpieczeństwie produktu", "producent odpowiedzialny"/"podmiot
 * odpowiedzialny w UE"), bo wiele sklepów nie nazywa sekcji literalnie "GPSR" w treści strony.
 * Wyeksportowana jako czysta funkcja regexowa, żeby dało się ją testować bez prawdziwego DOM-a —
 * reszta detekcji (przejście po nagłówkach strony) wymaga już żywego querySelectorAll.
 */
export const GPSR_HEADING_RE = /gpsr|producent odpowiedzialny|podmiot odpowiedzialny.{0,20}\bUE\b/i;
const SAFETY_STEM_RE = /bezpiecze[nń]stw\w*/i; // rdzeń — łapie bezpieczeństwo/-a/-u/-em/-ie (wszystkie przypadki)
const PRODUCT_WORD_RE = /produkt\w*/i;

export function looksLikeGpsrHeading(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (GPSR_HEADING_RE.test(value)) return true;
  return SAFETY_STEM_RE.test(value) && PRODUCT_WORD_RE.test(value);
}

const GPSR_HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6,summary,dt,legend,strong,b";
const GPSR_CONTAINER_SELECTOR = "details,section,article,div,dl";

/**
 * Wykrywa blok informacji GPSR na stronie produktu: najpierw selektory bezpośrednie
 * (GPSR_SELECTORS), a jeśli nic nie pasuje — szuka nagłówka/etykiety dopasowującej
 * GPSR_HEADING_RE i bierze tekst najbliższego sensownego kontenera (details/section/div itp.)
 * jako wartość. To fallback, bo sklepy renderują tę sekcję na bardzo różne sposoby (dedykowany
 * blok, zakładka, akordeon) — nie ma tu jednego standardu jak przy schema.org.
 * @param {Document|Element} root
 */
export function detectGpsrInfo(root) {
  const direct = firstMatch(root, GPSR_SELECTORS, textOf);
  if (direct) return { selector: direct.selector, value: direct.value };

  let headings;
  try {
    headings = root.querySelectorAll ? Array.from(root.querySelectorAll(GPSR_HEADING_SELECTOR)) : [];
  } catch {
    headings = [];
  }
  for (const heading of headings) {
    const headingText = textOf(heading);
    if (!looksLikeGpsrHeading(headingText)) continue;
    const container = (heading.closest && heading.closest(GPSR_CONTAINER_SELECTOR)) || heading.parentElement;
    if (!container) continue;
    const value = textOf(container);
    if (value && value.length > headingText.length) {
      return { selector: null, value };
    }
  }
  return null;
}

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

  const gpsr = detectGpsrInfo(root);
  if (gpsr) {
    fields.gpsr = { source: "dom", selector: gpsr.selector || "", attr: "text", multiple: false, value: gpsr.value };
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
