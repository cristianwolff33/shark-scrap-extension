/**
 * @file Service worker MV3. Otwiera side panel po kliknięciu ikony, i wymusza poprawną nazwę
 * pliku dla pobrań uruchomionych przez sidepanel/main.js (patrz onDeterminingFilename niżej).
 * Wiadomości PICKER_RESULT/PICKER_CANCELLED z content/picker.js trafiają bezpośrednio do
 * side panelu przez chrome.runtime.onMessage (broadcast bez tabId), więc nie ma tu przekaźnika.
 */

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })?.catch((err) => {
    console.error("[scraper-ext] setPanelBehavior failed:", err);
  });
});

/**
 * Zweryfikowane bezpośrednio w konsoli service workera usera: `typeof chrome.sidePanel` to
 * dosłownie "undefined" w jego Operze — mimo że Opera OGŁOSIŁA wsparcie dla chrome.sidePanel
 * (wersja 135, wrzesień 2026), to konkretna instalacja go nie ma (stopniowe wdrożenie funkcji
 * albo starsza wersja niż zakładał user). Żaden kod JS nie przywoła nieistniejącego API — jedyne
 * wyjście to NIE polegać na side panelu wcale, gdy go brak, tylko otworzyć TEN SAM plik
 * sidepanel.html jako osobne, pływające okno rozszerzenia (chrome.windows.create) zamiast
 * dokowanego panelu. main.js nie musi o tym nic wiedzieć poza jednym wyjątkiem — patrz
 * isFloatingWindowMode / getTrackedWindowId w sidepanel/main.js, bo "okno, w którym siedzi panel"
 * przestaje być tym samym oknem co przeglądana strona sklepu.
 */
let popupWindowId = null;

async function openAsFloatingWindow() {
  if (popupWindowId !== null) {
    try {
      await chrome.windows.update(popupWindowId, { focused: true });
      return;
    } catch {
      popupWindowId = null; // okno już nie istnieje (user je zamknął) — otwieramy nowe niżej
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("sidepanel/sidepanel.html"),
    type: "popup",
    width: 420,
    height: 720,
  });
  popupWindowId = win.id;
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) popupWindowId = null;
});

if (chrome.sidePanel?.open) {
  /**
   * JAWNY sposób otwierania panelu po kliknięciu ikonki — niezależny od setPanelBehavior wyżej,
   * na wypadek przeglądarki, która ma chrome.sidePanel, ale nie honoruje deklaratywnego
   * setPanelBehavior({openPanelOnActionClick:true}) tak jak Chrome. sidePanel.open() jest
   * bezpieczne do wywołania nawet w Chrome, gdzie panel i tak już się otworzy przez
   * setPanelBehavior — nie koliduje z powyższym mechanizmem, tylko dubluje go na wszelki wypadek.
   * MUSI być wywołane synchronicznie w handlerze kliknięcia (bez żadnego await przed nim) — tak
   * samo jak showDirectoryPicker, sidePanel.open() wymaga aktywnego gestu usera.
   */
  chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => {
      console.error("[scraper-ext] sidePanel.open failed:", err);
    });
  });
} else {
  // Brak chrome.sidePanel w ogóle (patrz komentarz wyżej) — jedyna opcja to pływające okno.
  chrome.action.onClicked.addListener(() => {
    openAsFloatingWindow().catch((err) => console.error("[scraper-ext] openAsFloatingWindow failed:", err));
  });
}

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
