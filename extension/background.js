// Background Service Worker for Dark Mode (Manifest V3)

chrome.runtime.onInstalled.addListener((details) => {
    console.log("Dark Mode extension installed/updated:", details.reason);
    chrome.storage.local.get(["serverUrl", "defaultMode"], (result) => {
        const updates = {};
        if (!result.serverUrl) updates.serverUrl = "http://localhost:8000";
        if (!result.defaultMode) updates.defaultMode = "auto";
        if (Object.keys(updates).length > 0) {
            chrome.storage.local.set(updates);
        }
    });
});

async function proxyFetch(targetUrl, method, headers, body) {
    const fetchOptions = {
        method: method || 'GET',
        headers: headers || { 'Content-Type': 'application/json' },
    };
    if (body && method !== 'GET') {
        fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    let res;
    try {
        res = await fetch(targetUrl, fetchOptions);
    } catch (primaryErr) {
        // Automatic fallback between localhost and 127.0.0.1 to guard against IPv4/IPv6 resolution mismatch on Windows
        let fallbackUrl = null;
        if (targetUrl.includes('localhost:8000')) {
            fallbackUrl = targetUrl.replace('localhost:8000', '127.0.0.1:8000');
        } else if (targetUrl.includes('127.0.0.1:8000')) {
            fallbackUrl = targetUrl.replace('127.0.0.1:8000', 'localhost:8000');
        }

        if (fallbackUrl) {
            res = await fetch(fallbackUrl, fetchOptions);
        } else {
            throw primaryErr;
        }
    }
    return res;
}

// Handle screenshot capture and backend proxy requests from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "captureVisibleTab") {
        chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
            if (chrome.runtime.lastError) {
                console.error("Capture failed:", chrome.runtime.lastError.message);
                sendResponse({ error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ dataUrl: dataUrl });
            }
        });
        return true; // Keep the message channel open for async response
    }

    if (request.action === "backendRequest") {
        (async () => {
            try {
                let baseUrl = request.serverUrl || "http://localhost:8000";
                baseUrl = baseUrl.replace(/\/+$/, '');
                const endpoint = request.endpoint.startsWith('/') ? request.endpoint : `/${request.endpoint}`;
                const targetUrl = `${baseUrl}${endpoint}`;

                const res = await proxyFetch(targetUrl, request.method, request.headers, request.body);

                const contentType = res.headers.get('content-type') || '';
                let data = null;
                if (contentType.includes('application/json')) {
                    data = await res.json().catch(() => null);
                } else {
                    data = await res.text().catch(() => null);
                }

                if (!res.ok) {
                    let errMsg = `HTTP ${res.status}`;
                    if (data && typeof data === 'object') {
                        if (data.detail) {
                            if (typeof data.detail === 'object') {
                                errMsg = data.detail.message || (Array.isArray(data.detail.errors) ? data.detail.errors.join(' | ') : JSON.stringify(data.detail));
                            } else {
                                errMsg = data.detail;
                            }
                        } else if (data.message) {
                            errMsg = data.message;
                        }
                    } else if (typeof data === 'string' && data.length > 0) {
                        errMsg = data.slice(0, 300);
                    }
                    sendResponse({ ok: false, status: res.status, error: errMsg, data });
                } else {
                    sendResponse({ ok: true, status: res.status, data });
                }
            } catch (err) {
                console.error("Background API proxy error:", err);
                sendResponse({ ok: false, status: 0, error: err.message || 'Failed to connect to backend server' });
            }
        })();
        return true; // Required for async sendResponse in MV3
    }
});
