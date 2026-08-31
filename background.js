/**
 * @file Service worker MV3. Minimalny — tylko otwiera side panel po kliknięciu ikony.
 * Wiadomości PICKER_RESULT/PICKER_CANCELLED z content/picker.js trafiają bezpośrednio do
 * side panelu przez chrome.runtime.onMessage (broadcast bez tabId), więc nie ma tu przekaźnika.
 */

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
    console.error("[scraper-ext] setPanelBehavior failed:", err);
  });
});
