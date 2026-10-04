document.addEventListener('DOMContentLoaded', () => {
    const serverUrlInput = document.getElementById('server-url');
    const defaultModeSelect = document.getElementById('default-mode');
    const defaultLangSelect = document.getElementById('default-lang');
    const panelThemeSelect = document.getElementById('panel-theme');
    const form = document.getElementById('options-form');
    const status = document.getElementById('status');

    const DEFAULT_SERVER = 'http://localhost:8000';
    const DEFAULT_MODE = 'code';
    const DEFAULT_LANG = 'cpp';
    const DEFAULT_THEME = 'glass';

    // Load saved options
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get({
            serverUrl: DEFAULT_SERVER,
            defaultMode: DEFAULT_MODE,
            defaultLanguage: DEFAULT_LANG,
            panelTheme: DEFAULT_THEME
        }, (items) => {
            serverUrlInput.value = items.serverUrl || DEFAULT_SERVER;
            defaultModeSelect.value = items.defaultMode || DEFAULT_MODE;
            if (defaultLangSelect) defaultLangSelect.value = items.defaultLanguage || DEFAULT_LANG;
            if (panelThemeSelect) panelThemeSelect.value = items.panelTheme || DEFAULT_THEME;
        });
    } else {
        serverUrlInput.value = DEFAULT_SERVER;
        defaultModeSelect.value = DEFAULT_MODE;
        if (defaultLangSelect) defaultLangSelect.value = DEFAULT_LANG;
        if (panelThemeSelect) panelThemeSelect.value = DEFAULT_THEME;
    }

    // Save options
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        let serverUrl = serverUrlInput.value.trim().replace(/\/+$/, '') || DEFAULT_SERVER;
        if (serverUrl && !serverUrl.startsWith('http://') && !serverUrl.startsWith('https://')) {
            serverUrl = 'http://' + serverUrl;
        }
        serverUrlInput.value = serverUrl;
        const defaultMode = defaultModeSelect.value || DEFAULT_MODE;
        const defaultLanguage = defaultLangSelect ? (defaultLangSelect.value || DEFAULT_LANG) : DEFAULT_LANG;
        const panelTheme = panelThemeSelect ? (panelThemeSelect.value || DEFAULT_THEME) : DEFAULT_THEME;

        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({
                serverUrl: serverUrl,
                defaultMode: defaultMode,
                defaultLanguage: defaultLanguage,
                panelTheme: panelTheme
            }, () => {
                showStatus('Settings saved successfully!');
            });
        } else {
            showStatus('Settings saved locally.');
        }
    });

    function showStatus(message) {
        status.textContent = message;
        status.style.display = 'inline';
        setTimeout(() => {
            status.textContent = '';
        }, 2500);
    }
});
