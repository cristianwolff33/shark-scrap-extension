# extension/ — Scraper Client Configurator (MVP)

Rozszerzenie Chrome (Manifest V3, vanilla JS/ES modules — bez build-stepu) do konfigurowania
scrapingu e-commerce bez ręcznego pisania adaptera. Pełna instrukcja: [`../docs/EXTENSION_BRIDGE.md`](../docs/EXTENSION_BRIDGE.md).

## Struktura

- `manifest.json` — MV3, side panel, content scripts na `<all_urls>`.
- `lib/` — czysta logika (detekcja JSON-LD/microdata/meta/DOM, generowanie selektorów,
  scoring listingu, merge źródeł) — zero zależności od `chrome.*`, testowane przez `node --test`.
- `content/detector.js`, `content/picker.js` — cienkie warstwy DOM-owe, importują `lib/*` dynamicznie.
- `sidepanel/` — UI panelu bocznego.
- `background.js` — service worker (tylko otwiera side panel).
- `test/` — testy jednostkowe czystej logiki (bez przeglądarki, bez npm).

## Testy

```bash
node --test test/*.test.js
```

## Ładowanie jako unpacked extension

`chrome://extensions` → Tryb dewelopera → Wczytaj rozpakowane → wskaż ten katalog.
