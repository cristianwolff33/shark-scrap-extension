/**
 * @file Content script (klasyczny, nie-module) wstrzykiwany deklaratywnie na wszystkie strony.
 * Sam nic nie robi dopóki nie dostanie wiadomości z side panelu — wtedy dynamicznie importuje
 * czyste moduły z lib/ (wymaga web_accessible_resources w manifest.json) i wykonuje detekcję.
 * Trzymanie ciężkiej logiki w lib/*.js (a nie tutaj) jest tym, co pozwala ją testować w Node.
 *
 * SCAN_CATALOG (auto-skan całej witryny) jest tu, bo wymaga prawdziwego DOM-a (fetch + DOMParser
 * po stronach listingu/produktów) — orkiestracja jest więc z natury nietestowalna w Node, ale
 * cała jej "matematyka" (rozwiązywanie URL-i, dedup, limity, heurystyka trybu) żyje w
 * lib/crawler.js i JEST testowana (patrz test/crawler.test.js).
 */

async function loadLib(name) {
  const url = chrome.runtime.getURL(`lib/${name}`);
  return import(url);
}

function collectJsonLdStrings(doc = document) {
  return Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).map((el) => el.textContent || "");
}

function collectMetaPairs(doc = document) {
  return Array.from(doc.querySelectorAll("meta")).map((el) => [
    el.getAttribute("property") || el.getAttribute("name") || "",
    el.getAttribute("content") || "",
  ]);
}

/** @param {Document} doc @param {string} pageUrl */
async function detectProductFromDoc(doc, pageUrl) {
  const [{ detectFromJsonLd }, { detectFromMicrodata }, { mapOgTags }, { detectFromDom }, { mergeFieldSources }] = await Promise.all([
    loadLib("jsonld.js"),
    loadLib("microdata.js"),
    loadLib("meta.js"),
    loadLib("dom-heuristics.js"),
    loadLib("fields.js"),
  ]);

  const jsonld = detectFromJsonLd(collectJsonLdStrings(doc));
  const microdata = detectFromMicrodata(doc);
  const meta = mapOgTags(collectMetaPairs(doc));
  const dom = detectFromDom(doc);

  const merged = mergeFieldSources({}, jsonld.fields, microdata.fields, meta, dom.fields);

  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href") || "";
  if (!merged.product_url && canonical) {
    merged.product_url = { source: "canonical", attr: "href", multiple: false, value: canonical };
  } else if (!merged.product_url) {
    merged.product_url = { source: "canonical", attr: "href", multiple: false, value: pageUrl };
  }

  return {
    url: pageUrl,
    domain: (() => { try { return new URL(pageUrl).hostname; } catch { return ""; } })(),
    detectedFrom: { jsonld: jsonld.found, microdata: microdata.found, meta: Object.keys(meta).length > 0, dom: dom.found },
    fields: merged,
  };
}

async function detectProduct() {
  return detectProductFromDoc(document, location.href);
}

/** Grupuje elementy strony wg sygnatury (tag + stabilna klasa) i szuka powtarzalnych "kart produktu". */
async function detectListingFromDoc(doc) {
  const [{ pickStableClass }, { groupSignature, pickBestGroup, PRICE_LIKE_RE }] = await Promise.all([
    loadLib("selectors.js"),
    loadLib("listing.js"),
  ]);

  /** @type {Map<string, {selector:string, els:Element[]}>} */
  const groups = new Map();
  const candidates = doc.querySelectorAll("body *");
  for (const el of candidates) {
    if (!el.children || el.children.length === 0) continue; // liście drzewa raczej nie są kartami
    if (!el.querySelector("a")) continue; // karta produktu prawie zawsze ma link
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "svg", "path", "nav", "header", "footer"].includes(tag)) continue;
    const stableClass = pickStableClass(el);
    if (!stableClass) continue; // bez stabilnej klasy zbyt ryzykowne grupowanie
    const sig = groupSignature(tag, stableClass);
    if (!groups.has(sig)) groups.set(sig, { selector: `${tag}.${stableClass}`, els: [] });
    groups.get(sig).els.push(el);
  }

  const descriptors = Array.from(groups.values())
    .filter((g) => g.els.length >= 3 && g.els.length <= 500)
    .map((g) => {
      const withLink = g.els.filter((el) => el.querySelector("a[href]")).length;
      const withImage = g.els.filter((el) => el.querySelector("img")).length;
      const withPriceLike = g.els.filter((el) => PRICE_LIKE_RE.test(el.textContent || "")).length;
      const avgTextLength = g.els.reduce((sum, el) => sum + (el.textContent || "").trim().length, 0) / g.els.length;
      return { selector: g.selector, count: g.els.length, withLink, withImage, withPriceLike, avgTextLength, _els: g.els };
    });

  const best = pickBestGroup(descriptors);
  if (!best) return { found: false, item_selector: "", url_selector: "", url_attribute: "href", detected_count: 0, sample_urls: [] };

  const group = descriptors.find((d) => d.selector === best.selector);
  const firstLink = group._els[0].querySelector("a[href]");
  const urlSelector = firstLink ? "a" : "";
  const sampleUrls = group._els
    .slice(0, 5)
    .map((el) => el.querySelector("a[href]")?.href)
    .filter(Boolean);

  return {
    found: true,
    item_selector: best.selector,
    url_selector: urlSelector,
    url_attribute: "href",
    detected_count: best.count,
    sample_urls: sampleUrls,
  };
}

async function detectListing() {
  return detectListingFromDoc(document);
}

async function detectPaginationFromDoc(doc) {
  const { pickNextLinkCandidate, pickLoadMoreCandidate } = await loadLib("listing.js");
  const { generateSelector } = await loadLib("selectors.js");

  const links = Array.from(doc.querySelectorAll("a")).map((a) => ({
    el: a,
    selector: "",
    text: (a.textContent || "").trim(),
    rel: a.getAttribute("rel") || "",
    hasHref: !!a.getAttribute("href"),
  }));
  const buttons = Array.from(doc.querySelectorAll("button, a")).map((el) => ({
    el,
    text: (el.textContent || "").trim(),
  }));

  const next = pickNextLinkCandidate(links);
  const loadMore = pickLoadMoreCandidate(buttons);

  if (next) {
    return { mode: "next_link", next_selector: generateSelector(next.el), load_more_selector: "", experimental: false };
  }
  if (loadMore) {
    return { mode: "load_more", next_selector: "", load_more_selector: generateSelector(loadMore.el), experimental: true };
  }
  return { mode: "none", next_selector: "", load_more_selector: "", experimental: false };
}

async function detectPagination() {
  return detectPaginationFromDoc(document);
}

// --- pełny auto-skan katalogu (SCAN_CATALOG) --------------------------------------

let scanStopRequested = false;

function extractItemUrlsFromDoc(doc, itemSelector, urlSelector, urlAttribute, baseUrl, resolveUrl) {
  if (!itemSelector) return [];
  const cards = Array.from(doc.querySelectorAll(itemSelector));
  const urls = [];
  for (const card of cards) {
    const linkEl = urlSelector ? card.querySelector(urlSelector) : card.matches("a") ? card : card.querySelector("a");
    if (!linkEl) continue;
    const raw = urlAttribute && urlAttribute !== "text" ? linkEl.getAttribute(urlAttribute) : linkEl.textContent;
    const abs = resolveUrl(raw, baseUrl);
    if (abs) urls.push(abs);
  }
  return urls;
}

function findNextUrlFromDoc(doc, pagination, baseUrl, resolveUrl) {
  if (!pagination || pagination.mode !== "next_link" || !pagination.next_selector) return null;
  try {
    const el = doc.querySelector(pagination.next_selector);
    if (!el) return null;
    const href = el.getAttribute("href");
    return resolveUrl(href, baseUrl);
  } catch {
    return null; // niepoprawny selektor (np. strona 2 ma inny DOM niż strona 1) — kończymy paginację
  }
}

async function fetchDoc(url) {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
  const html = await res.text();
  return new DOMParser().parseFromString(html, "text/html");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendProgress(payload) {
  try {
    chrome.runtime.sendMessage({ action: "SCAN_PROGRESS", ...payload });
  } catch {
    // panel mógł zostać zamknięty w trakcie skanu — ignorujemy, scan i tak działa do końca/Stop
  }
}

function sendProduct(product) {
  try {
    chrome.runtime.sendMessage({ action: "SCAN_PRODUCT", product });
  } catch {
    /* jw. */
  }
}

const HARD_PRODUCT_CAP = 500;
const REQUEST_DELAY_MS = 350; // uprzejmość wobec serwera sklepu — ten sam rząd wielkości co request_delay_seconds frameworka

/**
 * Pełny auto-skan: wykrywa listing+paginację+pola produktowe na bieżącej stronie (bez pytania
 * usera o nic) i sam przechodzi przez wszystkie strony listingu oraz wszystkie karty produktów,
 * zbierając dane wg tego samego priorytetu źródeł co pojedyncza detekcja (jsonld > microdata >
 * meta > dom). Zwraca zebrane produkty + wykryty listing/pola/pagination, żeby panel mógł
 * wypełnić resztę formularza (do ręcznej korekty, jeśli coś zawiodło).
 */
async function suggestMissingFieldsWithAi({ apiKey, aiModel, aiProvider, cloudAi }, bestSamplePair, missing) {
  const html = bestSamplePair.doc.documentElement.outerHTML;
  if (aiProvider === "cloud") {
    const { createBridgeClient } = await loadLib("bridge-client.js");
    const client = createBridgeClient(cloudAi?.baseUrl || "http://127.0.0.1:8766", fetch, {
      headers: cloudAi?.headers || {},
      serviceName: "cloud AI",
    });
    return client.suggestFields({ html, url: bestSamplePair.url, fields: missing, model: aiModel });
  }
  const { suggestFields } = await loadLib("openai-client.js");
  return suggestFields({ apiKey, model: aiModel, html, url: bestSamplePair.url, fields: missing });
}

async function scanCatalog({ maxPages, maxProducts, useAI, apiKey, aiModel, aiProvider, cloudAi } = {}) {
  scanStopRequested = false;
  const { resolveUrl, dedupe, capArray, guessAdapterMode, isAutoFollowablePagination, pickBestSample } = await loadLib("crawler.js");

  const baseUrl = location.href;
  const listing = await detectListing();
  const pagination = await detectPagination();

  if (!listing.found) {
    // Brak wykrytej listy na bieżącej stronie — traktujemy ją jako pojedynczy produkt (fallback),
    // żeby przycisk "Skanuj sklep" zawsze coś sensownego zrobił, nawet z karty produktu.
    const product = await detectProduct();
    sendProduct({ url: product.url, fields: product.fields, ok: true });
    return {
      mode: "single_product",
      listing,
      pagination,
      fieldMap: product.fields,
      products: [{ url: product.url, fields: product.fields, ok: true }],
      pagesVisited: 1,
      warnings: ["Nie wykryto listy produktów na bieżącej stronie — zeskanowano ją jako pojedynczy produkt. Wejdź na stronę kategorii, żeby zeskanować cały katalog."],
    };
  }

  const warnings = [];
  const effectiveMaxPages = Number.isFinite(maxPages) && maxPages > 0 ? maxPages : (pagination.max_pages || 20);
  const productCap = Math.min(Number.isFinite(maxProducts) && maxProducts > 0 ? maxProducts : HARD_PRODUCT_CAP, HARD_PRODUCT_CAP);

  if (pagination.mode !== "none" && !isAutoFollowablePagination(pagination)) {
    warnings.push(`Wykryto paginację typu "${pagination.mode}" (experimental) — auto-skan podąża tylko za "next link", więc pobrano tylko widoczne strony/produkty. Dociągnij resztę ręcznie albo v0.2.`);
  }

  // 1. Zbieramy URL-e produktów ze wszystkich stron listingu, którym możemy bezpiecznie podążyć.
  let pageUrls = [baseUrl];
  let currentDoc = document;
  let currentUrl = baseUrl;
  let pagesVisited = 0;
  let productUrls = [];

  while (pagesVisited < effectiveMaxPages && !scanStopRequested) {
    pagesVisited += 1;
    const urlsOnPage = extractItemUrlsFromDoc(currentDoc, listing.item_selector, listing.url_selector, listing.url_attribute, currentUrl, resolveUrl);
    productUrls.push(...urlsOnPage);
    productUrls = dedupe(productUrls);
    sendProgress({ phase: "listing", pagesVisited, pagesTotal: effectiveMaxPages, productsFound: productUrls.length });

    if (productUrls.length >= productCap) break;
    if (!isAutoFollowablePagination(pagination)) break;

    const nextUrl = findNextUrlFromDoc(currentDoc, pagination, currentUrl, resolveUrl);
    if (!nextUrl || nextUrl === currentUrl) break;
    await sleep(REQUEST_DELAY_MS);
    try {
      currentDoc = await fetchDoc(nextUrl);
      currentUrl = nextUrl;
    } catch (err) {
      warnings.push(`Przerwano podążanie za paginacją: ${err.message || err}`);
      break;
    }
  }

  productUrls = capArray(dedupe(productUrls), productCap);

  // 2. Pola produktowe: detekcja na próbce (do 3 kart) — wygrywa najlepsza (najwięcej niepustych pól),
  //    potem to samo źródło pól stosujemy do KAŻDEGO produktu (jsonld/microdata path'y są strukturalne,
  //    css/dom selektory generalizują się na kartach z tego samego szablonu).
  const sampleUrls = capArray(productUrls, 3);
  const samples = []; // {fields, doc, url}[] — trzymamy doc, żeby ewentualny fallback AI (niżej) mógł zweryfikować selektor na tej samej stronie
  for (const url of sampleUrls) {
    try {
      const doc = url === baseUrl ? document : await fetchDoc(url);
      const detected = await detectProductFromDoc(doc, url);
      samples.push({ fields: detected.fields, doc, url });
    } catch {
      // próbka się nie powiodła — próbujemy kolejnej
    }
    await sleep(REQUEST_DELAY_MS);
  }
  const bestSample = pickBestSample(samples.map((s) => s.fields));
  const bestSamplePair = samples.find((s) => s.fields === bestSample);
  const fieldMap = bestSample || {};
  const guessedMode = guessAdapterMode(fieldMap);
  if (Object.keys(fieldMap).length === 0) {
    warnings.push("Nie udało się automatycznie wykryć żadnych pól produktowych z próbki — uzupełnij ręcznie (Wskaż element).");
  }

  // 2b. Fallback AI (opt-in, patrz sidepanel — checkbox "Użyj AI"): TYLKO dla pól, których nic
  // powyższego nie znalazło, TYLKO raz na skan (kontrola kosztu), a zwrócony selektor jest
  // ZAWSZE zweryfikowany na żywym DOM próbki przed przyjęciem — nigdy nie ufamy modelowi ślepo.
  // W trybie cloud woła backendowe AI API (klucze modelu zostają na serwerze). W trybie local
  // zostaje direct OpenAI dev flow z chrome.storage.local.
  if (useAI && bestSamplePair && (aiProvider === "cloud" || apiKey)) {
    const { PRODUCT_FIELDS } = await loadLib("schema.js");
    const { valueForAttr } = await loadLib("selectors.js");
    const missing = PRODUCT_FIELDS.filter((f) => !fieldMap[f]);
    if (missing.length > 0) {
      try {
        const res = await suggestMissingFieldsWithAi({ apiKey, aiModel, aiProvider, cloudAi }, bestSamplePair, missing);
        let accepted = 0;
        for (const s of res.suggestions || []) {
          if (!s.found || !s.selector) continue;
          let elVal = null;
          try {
            const el = bestSamplePair.doc.querySelector(s.selector);
            elVal = el ? valueForAttr(el, s.attr) : null;
          } catch {
            elVal = null; // selektor niepoprawny (np. model zwrócił coś, czego querySelector nie przyjmie) — NIGDY nie ufamy ślepo
          }
          if (elVal !== null && elVal !== undefined && elVal !== "") {
            fieldMap[s.field] = { source: "ai", selector: s.selector, attr: s.attr, multiple: !!s.multiple, value: elVal };
            accepted += 1;
          } else {
            warnings.push(`AI zaproponowało selektor dla „${s.field}”, ale nie da się go zweryfikować na stronie — pominięto.`);
          }
        }
        if (accepted > 0) warnings.push(`AI (${res.model}) uzupełniło ${accepted} pole/pól — oznaczone badge'em "ai", zweryfikowane na żywym DOM. Sprawdź mimo to ręcznie.`);
      } catch (err) {
        warnings.push(`Fallback AI nie powiódł się (${err.message || err}) — kontynuuję bez niego.`);
      }
    }
  }

  // 3. Właściwe zbieranie danych z każdego produktu wg wykrytego field mapu.
  const products = [];
  let done = 0;
  for (const url of productUrls) {
    if (scanStopRequested) break;
    try {
      const doc = url === baseUrl ? document : await fetchDoc(url);
      const detected = await detectProductFromDoc(doc, url);
      // Scalamy: wynik z samej strony produktu wygrywa (świeża detekcja), field mapa z próbki
      // jest tylko rezerwą dla pól, których na tej konkretnej karcie nie udało się wykryć.
      const merged = { ...fieldMap, ...detected.fields };
      const record = { url, fields: merged, ok: true };
      products.push(record);
      sendProduct(record);
    } catch (err) {
      const record = { url, fields: {}, ok: false, error: String(err.message || err) };
      products.push(record);
      sendProduct(record);
    }
    done += 1;
    sendProgress({ phase: "products", pagesVisited, pagesTotal: effectiveMaxPages, productsFound: done, productsTotal: productUrls.length });
    await sleep(REQUEST_DELAY_MS);
  }

  return {
    mode: "catalog",
    listing,
    pagination,
    fieldMap,
    guessedMode,
    products,
    pagesVisited,
    warnings,
    stopped: scanStopRequested,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === "PING_CONTENT_SCRIPT") {
    sendResponse({ ok: true });
    return false;
  }
  if (message?.action === "DETECT_PRODUCT") {
    detectProduct().then(sendResponse).catch((err) => sendResponse({ error: String(err) }));
    return true;
  }
  if (message?.action === "DETECT_LISTING") {
    detectListing().then(sendResponse).catch((err) => sendResponse({ error: String(err) }));
    return true;
  }
  if (message?.action === "DETECT_PAGINATION") {
    detectPagination().then(sendResponse).catch((err) => sendResponse({ error: String(err) }));
    return true;
  }
  if (message?.action === "SCAN_CATALOG") {
    scanCatalog(message.options || {}).then(sendResponse).catch((err) => sendResponse({ error: String(err.message || err) }));
    return true;
  }
  if (message?.action === "STOP_SCAN") {
    scanStopRequested = true;
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
