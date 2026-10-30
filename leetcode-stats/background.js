// Клик по иконке расширения открывает (или фокусирует) страницу статистики.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('dashboard.html');
  try {
    const [tab] = await chrome.tabs.query({ url });
    if (tab) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
  } catch (e) { /* упадём в создание новой вкладки */ }
  chrome.tabs.create({ url });
});
