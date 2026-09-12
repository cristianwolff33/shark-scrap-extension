/**
 * @file Service worker MV3. Otwiera side panel po kliknięciu ikony, i wymusza poprawną nazwę
 * pliku dla pobrań uruchomionych przez sidepanel/main.js (patrz onDeterminingFilename niżej).
 * Wiadomości PICKER_RESULT/PICKER_CANCELLED z content/picker.js trafiają bezpośrednio do
 * side panelu przez chrome.runtime.onMessage (broadcast bez tabId), więc nie ma tu przekaźnika.
 */

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
    console.error("[scraper-ext] setPanelBehavior failed:", err);
  });
});

/**
 * User zgłaszał uporczywie, że pliki (CSV/XLSX/JSON/ZIP) lądowały pod losowym ciągiem znaków
 * (UUID samego adresu blob:) zamiast pod właściwą nazwą, MIMO że sidepanel/main.js jawnie
 * podaje `filename` w chrome.downloads.download(). To pole bywa zawodne dla adresów blob: —
 * znany, udokumentowany w społeczności problem rozszerzeń Chrome (silnik pobierania czasem nie
 * honoruje `filename` dla blob:, zwłaszcza gdy sama treść bloba nie niesie żadnej podpowiedzi
 * nazwy). `chrome.downloads.onDeterminingFilename` to WŁAŚCIWE, bardziej niezawodne API do
 * wymuszenia nazwy — działa NIEZALEŻNIE od tego, czy `filename` w download() zadziałał, czy nie.
 *
 * Żeby uniknąć wyścigu (przekazanie zamierzonej nazwy PRZEZ WIADOMOŚĆ do service workera MOGŁOBY
 * przyjść PO tym, jak Chrome zdąży już wywołać onDeterminingFilename), zamierzona nazwa jest
 * zakodowana wprost we fragmencie (#) adresu blob: przekazanego do download() — patrz
 * downloadBlobViaChrome w sidepanel/main.js. Fragment nie wpływa na to, JAKĄ treść zwróci blob:,
 * więc pobieranie nadal czyta właściwe bajty; służy tu wyłącznie jako niezawodny, synchroniczny
 * nośnik nazwy między side panelem a tym service workerem.
 */
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  try {
    if (!downloadItem.url.startsWith("blob:")) return; // nie ingerujemy w pobrania spoza naszej wtyczki
    const hash = new URL(downloadItem.url).hash;
    if (!hash || hash.length < 2) return;
    const filename = decodeURIComponent(hash.slice(1));
    if (filename) suggest({ filename, conflictAction: "uniquify" });
  } catch {
    // nietypowy URL/fragment — nie ingerujemy, Chrome użyje swojej domyślnej logiki
  }
});
