document.addEventListener('DOMContentLoaded', () => {
    const statusEl = document.getElementById('server-status');
    const optionsBtn = document.getElementById('open-options');
    const openPanelBtn = document.getElementById('btn-open-panel');
    const scanTextBtn = document.getElementById('btn-scan-text');
    const scanVisionBtn = document.getElementById('btn-scan-vision');

    if (optionsBtn) {
        optionsBtn.addEventListener('click', () => {
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.openOptionsPage) {
                chrome.runtime.openOptionsPage();
            } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
                window.open(chrome.runtime.getURL('options.html'));
            } else {
                window.open('options.html');
            }
        });
    }

    function sendActionToTab(action) {
        if (typeof chrome === 'undefined' || !chrome.tabs) return;
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs || tabs.length === 0) return;
            const tabId = tabs[0].id;
            const url = tabs[0].url || "";

            // Restrict on special browser URLs where content script cannot run
            if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
                alert('Browser Assistant cannot run on restricted browser internal pages. Please test on a standard webpage.');
                return;
            }

            chrome.tabs.sendMessage(tabId, { action }, (res) => {
                if (chrome.runtime.lastError) {
                    // Content script not ready or injected yet; dynamically inject content script
                    if (chrome.scripting) {
                        chrome.scripting.executeScript({
                            target: { tabId: tabId },
                            files: ['content.js']
                        }, () => {
                            if (chrome.runtime.lastError) {
                                console.error("Script injection error:", chrome.runtime.lastError.message);
                            } else {
                                setTimeout(() => {
                                    chrome.tabs.sendMessage(tabId, { action });
                                }, 150);
                            }
                        });
                    }
                }
            });
        });
    }

    if (openPanelBtn) {
        openPanelBtn.addEventListener('click', () => {
            sendActionToTab('openAssistant');
            window.close();
        });
    }

    if (scanTextBtn) {
        scanTextBtn.addEventListener('click', () => {
            sendActionToTab('scanText');
            window.close();
        });
    }

    if (scanVisionBtn) {
        scanVisionBtn.addEventListener('click', () => {
            sendActionToTab('scanVision');
            window.close();
        });
    }

    const DEFAULT_SERVER = 'http://localhost:8000';

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get({ serverUrl: DEFAULT_SERVER }, (items) => {
            checkHealth(items.serverUrl || DEFAULT_SERVER);
        });
    } else {
        checkHealth(DEFAULT_SERVER);
    }

    function checkHealth(serverUrl) {
        if (!statusEl) return;
        const cleanUrl = serverUrl.replace(/\/+$/, '');

        function updateOnline(d) {
            const groqText = d.groq_configured ? 'Groq ✓' : 'Groq ✗';
            const ollamaText = d.ollama_model ? `Ollama (${d.ollama_model})` : '';
            statusEl.textContent = `Online (${groqText} | ${ollamaText})`;
            statusEl.className = 'online';
        }

        fetch(`${cleanUrl}/health`)
            .then((r) => {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(updateOnline)
            .catch(() => {
                const fallbackUrl = cleanUrl.includes('localhost:8000')
                    ? cleanUrl.replace('localhost:8000', '127.0.0.1:8000')
                    : cleanUrl.replace('127.0.0.1:8000', 'localhost:8000');
                fetch(`${fallbackUrl}/health`)
                    .then((r) => {
                        if (!r.ok) throw new Error('HTTP ' + r.status);
                        return r.json();
                    })
                    .then(updateOnline)
                    .catch(() => {
                        statusEl.textContent = 'Offline (Start backend: python main.py)';
                        statusEl.className = 'offline';
                    });
            });
    }
});
