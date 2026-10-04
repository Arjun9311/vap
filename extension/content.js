// Browser Assistant Content Script v2.1 (Manifest V3 Compatible)

(function () {
    console.log("Browser Assistant v2.1 loaded.");

    let SERVER = 'http://localhost:8000';
    let selectedMode = 'code'; // 'code' (primary), 'auto', 'mcq'
    let panelTheme = 'glass'; // 'glass', 'ultra-clear', 'light-glass', 'dark-glass'
    let currentLanguage = "cpp"; // Default to C++ as primary language

    // ── Load options from chrome.storage.local ────────────────────────────────
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get({ serverUrl: 'http://localhost:8000', defaultMode: 'code', defaultLanguage: 'cpp', panelTheme: 'glass' }, (items) => {
            if (items.serverUrl) SERVER = items.serverUrl.replace(/\/+$/, '');
            if (items.defaultMode) selectedMode = items.defaultMode;
            if (items.defaultLanguage) currentLanguage = items.defaultLanguage;
            if (items.panelTheme) panelTheme = items.panelTheme;
            checkServer();
        });

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local') {
                if (changes.serverUrl && changes.serverUrl.newValue) {
                    SERVER = changes.serverUrl.newValue.replace(/\/+$/, '');
                    checkServer();
                }
                if (changes.defaultMode && changes.defaultMode.newValue) {
                    selectedMode = changes.defaultMode.newValue;
                    render();
                }
                if (changes.defaultLanguage && changes.defaultLanguage.newValue) {
                    currentLanguage = changes.defaultLanguage.newValue;
                    render();
                }
                if (changes.panelTheme && changes.panelTheme.newValue) {
                    panelTheme = changes.panelTheme.newValue;
                    render();
                }
            }
        });
    }

    // Safe DOM insertion for assistant container root
    let root = document.getElementById('assistant-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'assistant-root';

        function mountRoot() {
            if (document.getElementById('assistant-root')) return;
            const parent = document.body || document.documentElement;
            if (parent) {
                parent.appendChild(root);
            }
        }

        if (document.body || document.documentElement) {
            mountRoot();
        }
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', mountRoot);
        }
    }

    // ── Drag-to-anywhere ──────────────────────────────────────────────────────
    let dragState = { dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 };

    function initDrag() {
        root.addEventListener('mousedown', (e) => {
            // Drag only when user grabs the header (.assistant-header) or collapsed stealth badge
            const isHeader = e.target.closest('.assistant-header');
            const isCollapsedBadge = e.target.closest('#assistant-trigger');
            if (!isHeader && !isCollapsedBadge) return;

            // Never drag if clicking interactive buttons or close icon
            if (e.target.closest('button, .assistant-close, input, select, textarea, a')) return;

            dragState.dragging = true;
            dragState.startX = e.clientX;
            dragState.startY = e.clientY;
            const rect = root.getBoundingClientRect();
            dragState.origX = rect.left;
            dragState.origY = rect.top;
            root.style.cursor = 'grabbing';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragState.dragging) return;
            const dx = e.clientX - dragState.startX;
            const dy = e.clientY - dragState.startY;
            let newX = dragState.origX + dx;
            let newY = dragState.origY + dy;
            // Clamp to viewport boundaries
            const width = root.offsetWidth || 380;
            const height = root.offsetHeight || 400;
            newX = Math.max(10, Math.min(window.innerWidth - width - 10, newX));
            newY = Math.max(10, Math.min(window.innerHeight - height - 10, newY));
            root.style.right = 'auto';
            root.style.bottom = 'auto';
            root.style.left = newX + 'px';
            root.style.top = newY + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (dragState.dragging) {
                dragState.dragging = false;
                root.style.cursor = 'grab';
            }
        });

        // Wheel event listener: prevent background website from stealing scroll focus
        root.addEventListener('wheel', (e) => {
            const resultsEl = document.getElementById('assistant-results');
            if (resultsEl) {
                e.stopPropagation();
            }
        }, { passive: true });

        root.style.cursor = 'grab';
        root.title = 'Drag by header to move assistant panel';
    }

    initDrag();

    let isCollapsed = true;
    let isMinimalMode = false;
    let lastResultSummary = "";
    let isHidden = false;
    let serverOnline = null; // null = unknown, true/false = checked
    let currentResults = null;
    let currentProvider = "";
    // currentLanguage is initialized to "cpp" at top

    // ── Extension Message Listener (Popup & Background trigger) ───────────────
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === "openAssistant" || request.action === "toggleAssistant") {
                isHidden = false;
                isCollapsed = false;
                root.style.display = 'block';
                render();
                sendResponse({ status: "opened" });
            } else if (request.action === "scanText") {
                isHidden = false;
                isCollapsed = false;
                root.style.display = 'block';
                render();
                scanPage();
                sendResponse({ status: "scanning_text" });
            } else if (request.action === "scanVision") {
                isHidden = false;
                isCollapsed = false;
                root.style.display = 'block';
                render();
                visionScan();
                sendResponse({ status: "scanning_vision" });
            } else if (request.action === "ping") {
                sendResponse({ status: "pong" });
            }
            return true;
        });
    }

    // ── Backend API Proxy (Manifest V3 Safe) ──────────────────────────────────
    async function callBackend(endpoint, options = {}) {
        return new Promise((resolve, reject) => {
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({
                    action: "backendRequest",
                    endpoint: endpoint,
                    serverUrl: SERVER,
                    method: options.method || 'GET',
                    headers: options.headers || { 'Content-Type': 'application/json' },
                    body: options.body
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        return reject(new Error(chrome.runtime.lastError.message));
                    }
                    if (!response) {
                        return reject(new Error("No response from extension background"));
                    }
                    if (!response.ok) {
                        const errMsg = typeof response.error === 'object'
                            ? (response.error.message || JSON.stringify(response.error))
                            : (response.error || `Server error (${response.status})`);
                        return reject(new Error(errMsg));
                    }
                    resolve(response.data);
                });
            } else {
                // Direct fetch fallback for non-extension environments
                fetch(`${SERVER}${endpoint}`, options)
                    .then(async (res) => {
                        if (!res.ok) {
                            const err = await res.json().catch(() => ({}));
                            const msg = typeof err.detail === 'object'
                                ? (err.detail.message || JSON.stringify(err.detail))
                                : (err.detail || `Server error (${res.status})`);
                            throw new Error(msg);
                        }
                        return res.json();
                    })
                    .then(resolve)
                    .catch(reject);
            }
        });
    }

    // ── Server health check ───────────────────────────────────────────────────
    async function checkServer() {
        try {
            await callBackend('/health', { method: 'GET' });
            serverOnline = true;
        } catch {
            serverOnline = false;
        }
        if (!isCollapsed) render();
        return serverOnline;
    }

    checkServer();

    // ── Keyboard shortcuts ────────────────────────────────────────────────────
    window.addEventListener('keydown', (e) => {
        const active = document.activeElement;

        // Shield hotkeys if modifier key (Ctrl/Alt/Meta) is pressed
        if (e.ctrlKey || e.altKey || e.metaKey) return;

        // Shield hotkeys if user is focused inside input, textarea, contenteditable, or code editors
        if (active) {
            const isInput = active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable;
            const isCodeEditor = active.classList.contains('inputarea') ||
                active.classList.contains('cm-content') ||
                active.classList.contains('ace_text-input') ||
                Boolean(active.closest('.monaco-editor, .CodeMirror, .cm-editor, .ace_editor'));
            if (isInput || isCodeEditor) return;
        }

        if (e.key === '`') {
            e.preventDefault();
            isHidden = false;
            root.style.display = 'block';
            isCollapsed = false;
            render();
            scanPage();
        } else if (e.key === '\\') {
            e.preventDefault();
            isHidden = false;
            root.style.display = 'block';
            isCollapsed = false;
            render();
            visionScan();
        } else if (e.key === '[') {
            e.preventDefault();
            isMinimalMode = !isMinimalMode;
            render();
        } else if (e.key === ']') {
            e.preventDefault();
            isHidden = !isHidden;
            root.style.display = isHidden ? 'none' : 'block';
        }
    });

    // ── Comprehensive Problem & Page Scanner ──────────────────────────────────
    function extractPageText() {
        try {
            let problemTitle = "";
            let problemDesc = "";
            let constraintsText = "";
            let ioFormatText = "";
            let examplesText = "";
            let starterCodeText = "";

            // 1. Detect Problem Title
            const titleSelectors = [
                '[data-cy="question-title"]',
                '.text-title-large',
                '.problem-title',
                '.header .title',
                '.challenge-title',
                'h1.title',
                'h1',
                'h2.title'
            ];
            for (const sel of titleSelectors) {
                const el = document.querySelector(sel);
                if (el && el.innerText && el.innerText.trim().length > 2 && !el.closest('#assistant-root')) {
                    problemTitle = el.innerText.trim();
                    break;
                }
            }
            if (!problemTitle && document.title) {
                problemTitle = document.title.split('-')[0].split('|')[0].trim();
            }

            // 2. Extract Constraints & Limits
            const constraintSelectors = [
                '.constraints',
                '.problem-constraints',
                '.challenge-constraints',
                '[data-track-load="description_content"] ul',
                '.time-limit',
                '.memory-limit',
                '.problem-statement .time-limit',
                '.problem-statement .memory-limit'
            ];
            const foundConstraints = new Set();
            for (const sel of constraintSelectors) {
                document.querySelectorAll(sel).forEach(el => {
                    if (el && !el.closest('#assistant-root') && el.innerText.trim()) {
                        foundConstraints.add(el.innerText.trim());
                    }
                });
            }

            // Scan headings/elements explicitly containing "Constraint" or "Limit"
            document.querySelectorAll('h1, h2, h3, h4, h5, h6, strong, b, p, div').forEach(el => {
                if (el.closest('#assistant-root')) return;
                const txt = el.innerText ? el.innerText.trim() : "";
                if (/^constraints?[\s:]*$/i.test(txt) || /^limits?[\s:]*$/i.test(txt)) {
                    let next = el.nextElementSibling;
                    let count = 0;
                    while (next && count < 6) {
                        if (next.tagName && next.tagName.startsWith('H')) break;
                        const nTxt = next.innerText ? next.innerText.trim() : "";
                        if (nTxt) foundConstraints.add(nTxt);
                        next = next.nextElementSibling;
                        count++;
                    }
                }
            });
            constraintsText = Array.from(foundConstraints).join('\n');

            // 3. Extract Input & Output Specifications
            const ioSelectors = [
                '.input-specification',
                '.output-specification',
                '.challenge-input-format',
                '.challenge-output-format',
                '#input-format',
                '#output-format'
            ];
            const foundIO = new Set();
            for (const sel of ioSelectors) {
                document.querySelectorAll(sel).forEach(el => {
                    if (el && !el.closest('#assistant-root') && el.innerText.trim()) {
                        foundIO.add(el.innerText.trim());
                    }
                });
            }
            document.querySelectorAll('h1, h2, h3, h4, strong, b').forEach(el => {
                if (el.closest('#assistant-root')) return;
                const txt = el.innerText ? el.innerText.trim() : "";
                if (/(?:input\s*format|output\s*format|standard\s*input|standard\s*output)/i.test(txt)) {
                    let next = el.nextElementSibling;
                    let count = 0;
                    foundIO.add(txt);
                    while (next && count < 5) {
                        if (next.tagName && next.tagName.startsWith('H')) break;
                        const nTxt = next.innerText ? next.innerText.trim() : "";
                        if (nTxt) foundIO.add(nTxt);
                        next = next.nextElementSibling;
                        count++;
                    }
                }
            });
            ioFormatText = Array.from(foundIO).join('\n');

            // 4. Extract ALL Examples & Sample Test Cases
            const exampleSelectors = [
                '.example',
                '.example-block',
                '.sample-tests',
                '.sample-test',
                '.challenge-sample-test',
                '[data-track-load="description_content"] pre',
                '.problem-statement .sample-test',
                '.sample-input',
                '.sample-output',
                'pre.example',
                'pre'
            ];
            const foundExamples = new Set();
            for (const sel of exampleSelectors) {
                document.querySelectorAll(sel).forEach(el => {
                    if (el && !el.closest('#assistant-root')) {
                        const t = el.innerText ? el.innerText.trim() : "";
                        if (t && t.length > 5 && t.length < 3500) {
                            if (/example|input|output|sample|explanation/i.test(t) || el.tagName === 'PRE') {
                                foundExamples.add(t);
                            }
                        }
                    }
                });
            }
            examplesText = Array.from(foundExamples).slice(0, 12).join('\n\n');

            // 5. Extract Starter Code / Function Signature from Editors
            try {
                // Monaco editor lines
                const monacoLines = Array.from(document.querySelectorAll('.monaco-editor .view-lines .view-line'));
                if (monacoLines.length > 0) {
                    const rawM = monacoLines.map(l => l.innerText).join('\n').trim();
                    if (rawM.length > 8 && (rawM.includes('class') || rawM.includes('(') || rawM.includes('int') || rawM.includes('#include') || rawM.includes('def '))) {
                        starterCodeText = rawM;
                    }
                }
                // CodeMirror 6
                if (!starterCodeText) {
                    const cm6 = document.querySelector('.cm-content');
                    if (cm6 && cm6.innerText.trim().length > 8) {
                        starterCodeText = cm6.innerText.trim();
                    }
                }
                // CodeMirror 5
                if (!starterCodeText) {
                    const cm5 = document.querySelector('.CodeMirror');
                    if (cm5 && cm5.CodeMirror) {
                        starterCodeText = cm5.CodeMirror.getValue();
                    }
                }
                // Ace Editor
                if (!starterCodeText) {
                    const ace = document.querySelector('.ace_editor');
                    if (ace && window.ace) {
                        try {
                            const editor = window.ace.edit(ace);
                            starterCodeText = editor.getValue();
                        } catch (e) {}
                    }
                    if (!starterCodeText && ace) {
                        starterCodeText = ace.innerText.trim();
                    }
                }
                // Visible code textarea
                if (!starterCodeText) {
                    const textareas = document.querySelectorAll('textarea');
                    for (const ta of textareas) {
                        if (ta.offsetHeight > 80 && !ta.classList.contains('assistant-chat-input-field')) {
                            const v = ta.value.trim();
                            if (v.length > 8 && (v.includes('class') || v.includes('int') || v.includes('#include'))) {
                                starterCodeText = v;
                                break;
                            }
                        }
                    }
                }

                // Scan pre, code, and question containers for starter code template
                if (!starterCodeText) {
                    const candidateEls = document.querySelectorAll('pre, code, .code, .code-editor, [class*="code"], [class*="editor"]');
                    for (const el of candidateEls) {
                        if (el.closest('#assistant-root')) continue;
                        const txt = el.innerText ? el.innerText.trim() : "";
                        if (txt.length > 25 && txt.length < 5000) {
                            if (
                                (txt.includes('class solution') || txt.includes('class Solution') || txt.includes('#include')) &&
                                (txt.includes('//Write your code') || txt.includes('// Write your code') || txt.includes('//write your code') || txt.includes('public:') || txt.includes('orders') || txt.includes('// Complete') || txt.includes('// Your code'))
                            ) {
                                starterCodeText = txt;
                                break;
                            }
                        }
                    }
                }
            } catch (editorErr) {
                console.warn("Editor extraction warning:", editorErr);
            }

            // 6. Extract Main Problem Statement / Description
            const mainContainerSelectors = [
                '[data-track-load="description_content"]',
                '.problem-statement',
                '.challenge-body-html',
                '#problem-statement',
                '.problem-description',
                '.question-text-container',
                '.question-container',
                '.question-card',
                '.question-content',
                '.assessment-container',
                'article',
                'main',
                '[role="main"]'
            ];
            for (const sel of mainContainerSelectors) {
                const el = document.querySelector(sel);
                if (el && !el.closest('#assistant-root')) {
                    const t = el.innerText ? el.innerText.trim() : "";
                    if (t.length > 80) {
                        problemDesc = t;
                        break;
                    }
                }
            }
            if (!problemDesc) {
                problemDesc = document.body ? document.body.innerText : "";
            }

            // Build structured, rich report for AI model
            let fullReport = "";
            if (problemTitle) {
                fullReport += `=== PROBLEM TITLE ===\n${problemTitle}\n\n`;
            }
            fullReport += `=== PROBLEM STATEMENT & DESCRIPTION ===\n${problemDesc}\n\n`;

            if (constraintsText) {
                fullReport += `=== CONSTRAINTS & LIMITS ===\n${constraintsText}\n\n`;
            }
            if (ioFormatText) {
                fullReport += `=== INPUT & OUTPUT SPECIFICATION ===\n${ioFormatText}\n\n`;
            }
            if (examplesText) {
                fullReport += `=== EXAMPLES & TEST CASES ===\n${examplesText}\n\n`;
            }
            if (starterCodeText) {
                fullReport += `=== STARTER CODE / SIGNATURE IN EDITOR ===\n${starterCodeText}\n\n`;
            }

            return fullReport.trim();
        } catch (e) {
            console.error("Full problem extraction error:", e);
            return document.body ? document.body.innerText : "";
        }
    }

    // ── Vision scan ───────────────────────────────────────────────────────────
    async function visionScan() {
        setLoading("Capturing screen…");

        try {
            const response = await chrome.runtime.sendMessage({ action: "captureVisibleTab" });
            if (!response || response.error) {
                throw new Error(response ? response.error : 'Failed to capture screenshot');
            }

            setLoading("Analyzing image…");

            const data = await callBackend('/solve-vision', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: {
                    image: response.dataUrl,
                    url: window.location.href,
                    text: extractPageText()
                }
            });

            serverOnline = true;
            let parsed = data.results;
            if (typeof parsed === 'string') {
                try { parsed = JSON.parse(parsed); } catch (e) { parsed = []; }
            }
            if ((!parsed || parsed.length === 0) && data.code) {
                parsed = [{
                    type: 'code',
                    title: 'Complete C++ Solution',
                    languages: { cpp: data.code }
                }];
            }
            displayResults(parsed, data.provider);
        } catch (error) {
            console.error("Vision scan error:", error);
            if (error.message && (error.message.includes('Failed to fetch') || error.message.includes('NetworkError') || error.message.includes('No response') || error.message.includes('Failed to connect'))) {
                serverOnline = false;
                render();
            }
            showError(`Vision Error: ${error.message}`);
        }
    }

    // ── Page text scan ────────────────────────────────────────────────────────
    async function scanPage() {
        setLoading("Analyzing page…");

        const practiceType = detectPracticeType();
        const extractedText = extractPageText();

        try {
            const data = await callBackend('/solve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: {
                    text: extractedText,
                    url: window.location.href,
                    practice_type: practiceType
                }
            });

            serverOnline = true;
            let parsed = data.results;
            if (typeof parsed === 'string') {
                try { parsed = JSON.parse(parsed); } catch (e) { parsed = []; }
            }
            if ((!parsed || parsed.length === 0) && data.code) {
                parsed = [{
                    type: 'code',
                    title: 'Complete C++ Solution',
                    languages: { cpp: data.code }
                }];
            }
            displayResults(parsed, data.provider);
        } catch (error) {
            console.error("Page scan error:", error);
            if (error.message && (error.message.includes('Failed to fetch') || error.message.includes('NetworkError') || error.message.includes('No response') || error.message.includes('Failed to connect'))) {
                serverOnline = false;
                render();
            }
            showError(`Scan Error: ${error.message}`);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function setLoading(msg) {
        const c = document.getElementById('assistant-results');
        if (c) {
            c.innerHTML = `<div class="assistant-loading"><div class="assistant-spinner"></div>${msg}</div>`;
        } else {
            lastResultSummary = "WAIT";
            render();
        }
    }

    function showError(msg) {
        const c = document.getElementById('assistant-results');
        if (c) {
            c.innerHTML = `<div class="assistant-error">${msg}</div>`;
        } else {
            lastResultSummary = "ERR";
            render();
        }
    }

    function detectPracticeType() {
        if (selectedMode !== 'auto') return selectedMode;
        const hasInputs = document.querySelectorAll('input[type="radio"], input[type="checkbox"]').length > 0;
        if (hasInputs) return "mcq";
        const bodyText = document.body ? document.body.innerText : "";
        const upperText = bodyText.substring(0, 1500).toUpperCase();
        if (upperText.includes("MCQ PRACTICE") || upperText.includes("QUIZ") || upperText.includes("MCQ")) return "mcq";
        if (upperText.includes("CODING PRACTICE") || upperText.includes("CODING")) return "code";
        const title = document.title.toUpperCase();
        if (title.includes("MCQ")) return "mcq";
        if (title.includes("CODING")) return "code";
        return "auto";
    }

    // ── Render ────────────────────────────────────────────────────────────────
    function render() {
        if (isCollapsed) {
            const content = lastResultSummary || "";
            root.innerHTML = `
                <div class="assistant-tab collapsed ${content ? 'has-answer' : ''}" id="assistant-trigger" data-content="${content}" title="Click to open Browser Assistant">
                    ${isMinimalMode ? '<div class="assistant-mode-indicator">MIN</div>' : ''}
                </div>
            `;
            const triggerEl = document.getElementById('assistant-trigger');
            if (triggerEl) {
                triggerEl.onclick = () => {
                    isCollapsed = false;
                    lastResultSummary = "";
                    render();
                };
            }
        } else {
            const statusDot = serverOnline === false
                ? '<span class="status-dot offline" id="assistant-status-dot" style="cursor:pointer;" title="Server offline — click to check connection"></span>'
                : serverOnline === true
                    ? '<span class="status-dot online" id="assistant-status-dot" style="cursor:pointer;" title="Server online"></span>'
                    : '<span class="status-dot unknown" id="assistant-status-dot" style="cursor:pointer;" title="Checking server connection…"></span>';

            root.innerHTML = `
                <div class="assistant-tab theme-${panelTheme}" id="assistant-panel">
                    <div class="assistant-header">
                        <div class="assistant-title-row">
                            ${statusDot}
                            <h3 class="assistant-title">Browser Assistant</h3>
                        </div>
                        <button class="assistant-close" id="assistant-close-btn" title="Minimize">&times;</button>
                    </div>
                    <div class="assistant-content">
                        <div class="assistant-mode-switcher">
                            <button class="mode-btn ${selectedMode === 'auto' ? 'active' : ''}" id="mode-auto">AUTO</button>
                            <button class="mode-btn ${selectedMode === 'mcq'  ? 'active' : ''}" id="mode-mcq">MCQ</button>
                            <button class="mode-btn ${selectedMode === 'code' ? 'active' : ''}" id="mode-code">CODE</button>
                        </div>
                        <div class="assistant-btn-row">
                            <button class="assistant-btn" id="assistant-scan-btn">⚡ Scan (Text)</button>
                            <button class="assistant-btn secondary" id="assistant-vision-btn">📷 Scan (Vision)</button>
                        </div>
                        <div class="assistant-body" id="assistant-results">
                            <div class="assistant-placeholder">No results yet.<br><small>Press <kbd>\`</kbd> or click Scan.</small></div>
                        </div>
                    </div>
                </div>
            `;

            const closeBtn = document.getElementById('assistant-close-btn');
            if (closeBtn) closeBtn.onclick = () => { isCollapsed = true; render(); };
            const mAuto = document.getElementById('mode-auto');
            if (mAuto) mAuto.onclick = () => { selectedMode = 'auto'; render(); };
            const mMcq = document.getElementById('mode-mcq');
            if (mMcq) mMcq.onclick  = () => { selectedMode = 'mcq';  render(); };
            const mCode = document.getElementById('mode-code');
            if (mCode) mCode.onclick = () => { selectedMode = 'code'; render(); };
            const scanBtn = document.getElementById('assistant-scan-btn');
            if (scanBtn) scanBtn.onclick   = scanPage;
            const visionBtn = document.getElementById('assistant-vision-btn');
            if (visionBtn) visionBtn.onclick = visionScan;
            const dotEl = document.getElementById('assistant-status-dot');
            if (dotEl) dotEl.onclick = () => checkServer();
        }
    }

    // ── Display results ───────────────────────────────────────────────────────
    function displayResults(results, provider) {
        currentResults = results;
        currentProvider = provider;

        // Minimal mode: show answer letter on badge
        if (isMinimalMode) {
            if (results && results.length > 0) {
                const first = results[0];
                if (first.type === 'mcq') {
                    const match = (first.answer || "").match(/^Option\s*([A-E])/i)
                        || (first.answer || "").match(/\(([A-E])\)/i)
                        || (first.answer || "").match(/^([A-E])[:\s.-]/i)
                        || (first.answer || "").match(/[A-E]/i);
                    lastResultSummary = match ? match[1].toUpperCase() : "Ans";
                } else {
                    lastResultSummary = "OK";
                }
            } else {
                lastResultSummary = "None";
            }
            render();
            return;
        }

        if (results && results.length > 0) {
            isCollapsed = false;
            render();
            const container = document.getElementById('assistant-results');
            if (container) renderFullResults(container, results, provider);
        } else {
            const container = document.getElementById('assistant-results');
            if (container) container.innerHTML = '<div class="assistant-placeholder">No results found.</div>';
        }
    }

    function renderFullResults(container, results, provider) {
        container.innerHTML = `<div class="assistant-provider-badge">via ${provider.toUpperCase()}</div>`;

        results.forEach((res, index) => {
            const isCodeType = res.type === 'code' || Boolean(res.languages && res.languages.cpp) || Boolean(res.code) || (typeof res.answer === 'string' && (res.answer.includes('#include') || res.answer.includes('class Solution') || res.answer.includes('class solution')));
            if (isCodeType) {
                const languages = res.languages || {};
                if (!languages['cpp'] && typeof res.code === 'string' && res.code.trim()) {
                    languages['cpp'] = res.code.trim();
                }
                if (!languages['cpp'] && typeof res.answer === 'string' && (res.answer.includes('#include') || res.answer.includes('class '))) {
                    languages['cpp'] = res.answer.trim();
                }
                const hasMultiLang = Object.keys(languages).length > 0;

                // Prioritize C++ as default language if available
                if (hasMultiLang) {
                    if (languages['cpp']) {
                        currentLanguage = 'cpp';
                    } else if (!languages[currentLanguage]) {
                        currentLanguage = Object.keys(languages)[0];
                    }
                }

                let activeCode = hasMultiLang
                    ? (languages[currentLanguage] || "")
                    : (res.code || res.answer || "");

                if (!activeCode) return;

                const codeBox = document.createElement('div');
                codeBox.className = 'assistant-code-container';
                codeBox.id = `code-container-${index}`;

                // Language tabs: C++ first
                let tabsHtml = "";
                if (hasMultiLang) {
                    tabsHtml = `<div class="assistant-lang-tabs">`;
                    ['cpp', 'python', 'java', 'javascript'].forEach(lang => {
                        if (languages[lang]) {
                            const label = lang === 'cpp' ? '⚡ C++ (Optimal)' : lang === 'javascript' ? 'JS' : lang.charAt(0).toUpperCase() + lang.slice(1);
                            tabsHtml += `<button class="lang-tab-btn ${currentLanguage === lang ? 'active' : ''}" data-lang="${lang}">${label}</button>`;
                        }
                    });
                    tabsHtml += `</div>`;
                }

                // Constraints Section Card (if available)
                let constraintsHtml = "";
                if (res.constraints) {
                    constraintsHtml = `
                        <div class="assistant-section-card constraints-card">
                            <div class="assistant-card-header">
                                <span class="assistant-card-icon">⚡</span>
                                <span class="assistant-card-title">Constraints & Edge Cases</span>
                            </div>
                            <div class="assistant-card-body">${escapeHtml(res.constraints)}</div>
                        </div>
                    `;
                }

                // Inputs, Outputs & Examples Analysis Card (if available)
                let ioExamplesHtml = "";
                if (res.input_output_format || res.examples_walkthrough) {
                    ioExamplesHtml = `
                        <div class="assistant-section-card io-examples-card">
                            <div class="assistant-card-header">
                                <span class="assistant-card-icon">📋</span>
                                <span class="assistant-card-title">I/O Format & Examples Walkthrough</span>
                            </div>
                            <div class="assistant-card-body">
                                ${res.input_output_format ? `<div class="assistant-io-block"><strong>Input/Output:</strong> ${escapeHtml(res.input_output_format)}</div>` : ''}
                                ${res.examples_walkthrough ? `<div class="assistant-io-block"><strong>Examples:</strong> ${escapeHtml(res.examples_walkthrough)}</div>` : ''}
                            </div>
                        </div>
                    `;
                }

                // Complexity Row
                let complexityHtml = "";
                if (res.time_complexity || res.space_complexity) {
                    complexityHtml = `<div class="assistant-complexity-row">`;
                    if (res.time_complexity) {
                        complexityHtml += `<span class="complexity-badge time" title="Time Complexity">Time: ${res.time_complexity}</span>`;
                    }
                    if (res.space_complexity) {
                        complexityHtml += `<span class="complexity-badge space" title="Space Complexity">Space: ${res.space_complexity}</span>`;
                    }
                    complexityHtml += `</div>`;
                }

                // Collapsible Explanation
                let explanationHtml = "";
                if (res.explanation) {
                    explanationHtml = `
                        <details class="assistant-explanation-details">
                            <summary>Algorithm Explanation & Intuition</summary>
                            <div class="assistant-explanation-text">${escapeHtml(res.explanation)}</div>
                        </details>
                    `;
                }

                const currentLangLabel = hasMultiLang ? currentLanguage : (res.language || 'cpp');

                codeBox.innerHTML = `
                    ${tabsHtml}
                    ${constraintsHtml}
                    ${ioExamplesHtml}
                    <div class="assistant-code-header">
                        <span class="code-title-label">${escapeHtml(res.title || 'Complete C++ Solution')} (<span class="code-lang-name">${currentLangLabel.toUpperCase()}</span>)</span>
                        <div class="assistant-actions">
                            <button class="assistant-action-btn copy-btn" id="copy-btn-${index}" title="Copy pure clean C++ code">Copy Clean C++</button>
                            <button class="assistant-action-btn inject-btn" id="inject-btn-${index}">Inject</button>
                        </div>
                    </div>
                    <pre class="assistant-code-block" id="code-block-${index}">${highlightCode(activeCode, currentLangLabel)}</pre>
                    ${complexityHtml}
                    ${explanationHtml}
                `;
                container.appendChild(codeBox);

                // In-Place Tab Switcher Handler
                if (hasMultiLang) {
                    const tabBtns = codeBox.querySelectorAll('.lang-tab-btn');
                    tabBtns.forEach(btn => {
                        btn.onclick = (e) => {
                            const newLang = e.currentTarget.getAttribute('data-lang');
                            currentLanguage = newLang;
                            const newCode = languages[newLang] || "";
                            activeCode = newCode;

                            tabBtns.forEach(b => b.classList.remove('active'));
                            e.currentTarget.classList.add('active');

                            const codeBlockEl = codeBox.querySelector(`#code-block-${index}`);
                            const langNameEl = codeBox.querySelector('.code-lang-name');
                            if (codeBlockEl) codeBlockEl.innerHTML = highlightCode(newCode, newLang);
                            if (langNameEl) langNameEl.textContent = newLang.toUpperCase();
                        };
                    });
                }

                // Wire up actions
                const cBtn = document.getElementById(`copy-btn-${index}`);
                if (cBtn) cBtn.onclick = () => copyToClipboard(activeCode, `copy-btn-${index}`);
                const iBtn = document.getElementById(`inject-btn-${index}`);
                if (iBtn) iBtn.onclick = () => {
                    injectCodeIntoEditor(activeCode);
                    iBtn.innerText = 'Injected!';
                    iBtn.classList.add('success');
                    setTimeout(() => {
                        iBtn.innerText = 'Inject';
                        iBtn.classList.remove('success');
                    }, 2000);
                };
            } else {
                let answerText = res.answer || 'No answer found';
                // Automatically unwrap if the AI returned a stringified JSON array or object containing code
                if (typeof answerText === 'string' && (answerText.trim().startsWith('[') || answerText.trim().startsWith('{'))) {
                    try {
                        const inner = JSON.parse(answerText);
                        const innerArr = Array.isArray(inner) ? inner : [inner];
                        if (innerArr[0] && (innerArr[0].languages || innerArr[0].code || innerArr[0].type === 'code')) {
                            displayResults(innerArr, provider);
                            return;
                        }
                    } catch (e) {}
                }
                const item = document.createElement('div');
                item.className = 'assistant-answer';
                item.innerHTML = `
                    <div class="assistant-question-text">${escapeHtml(res.question || 'Question')}</div>
                    <div class="assistant-answer-text">${escapeHtml(answerText)}</div>
                `;
                container.appendChild(item);
            }
        });

        // Refinement Chat Box
        const chatSection = document.createElement('div');
        chatSection.className = 'assistant-chat-section';
        chatSection.innerHTML = `
            <div class="assistant-chat-header">Refine Solution / Ask C++ Question</div>
            <div class="assistant-chat-input-row">
                <input type="text" id="assistant-chat-input-field" placeholder="e.g. Optimize space in C++, add edge case for N=0..." />
                <button id="assistant-chat-send-btn">Send</button>
            </div>
        `;
        container.appendChild(chatSection);

        // Bind chat actions
        const sendBtn = document.getElementById('assistant-chat-send-btn');
        const inputField = document.getElementById('assistant-chat-input-field');

        const triggerRefinement = () => {
            const val = inputField.value.trim();
            if (!val) return;
            sendRefinement(val);
        };

        if (sendBtn) sendBtn.onclick = triggerRefinement;
        if (inputField) {
            inputField.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    triggerRefinement();
                }
            };
        }
    }

    async function sendRefinement(promptText) {
        setLoading("Refining solution…");
        if (serverOnline !== true) {
            const isOnline = await checkServer();
            if (!isOnline) {
                showError("Server offline. Start the backend with: python main.py");
                return;
            }
        }

        try {
            const data = await callBackend('/refine', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: {
                    text: extractPageText(),
                    url: window.location.href,
                    previous_results: JSON.stringify(currentResults),
                    prompt: promptText,
                    practice_type: selectedMode
                }
            });

            serverOnline = true;
            let parsed = data.results;
            if (typeof parsed === 'string') {
                try { parsed = JSON.parse(parsed); } catch (e) { parsed = []; }
            }
            if ((!parsed || parsed.length === 0) && data.code) {
                parsed = [{
                    type: 'code',
                    title: 'Refined C++ Solution',
                    languages: { cpp: data.code }
                }];
            }
            displayResults(parsed, data.provider);
        } catch (error) {
            console.error("Refinement error:", error);
            if (error.message && (error.message.includes('Failed to fetch') || error.message.includes('NetworkError') || error.message.includes('No response') || error.message.includes('Failed to connect'))) {
                serverOnline = false;
                render();
            }
            showError(`Refinement Error: ${error.message}`);
            setTimeout(() => {
                if (currentResults) {
                    displayResults(currentResults, currentProvider);
                }
            }, 3000);
        }
    }

    function highlightCode(code, lang) {
        if (!code) return "";
        let escaped = escapeHtml(code);

        // Preprocessor directives (#include, #define, etc.)
        escaped = escaped.replace(/(#(?:include|define|ifdef|ifndef|endif|pragma)[^\n\r]*)/g, '<span class="token preprocessor">$1</span>');

        // Extract comments safely
        let comments = [];
        escaped = escaped.replace(/(\/\/.*$|\/\*[\s\S]*?\*\/|#.*$)/gm, (match) => {
            if (match.startsWith('<span class="token preprocessor">')) return match;
            comments.push(match);
            return `___COMMENT_${comments.length - 1}___`;
        });

        // Extract strings safely (including escaped quotes)
        let strings = [];
        escaped = escaped.replace(/(["'])(?:(?=(\\?))\2[\s\S])*?\1/g, (match) => {
            strings.push(match);
            return `___STRING_${strings.length - 1}___`;
        });

        // Comprehensive C++ & General Competitive Programming Keywords
        const keywords = [
            'int', 'long', 'double', 'float', 'char', 'bool', 'void', 'auto', 'size_t', 'uint32_t', 'uint64_t',
            'const', 'static', 'constexpr', 'inline', 'virtual', 'override', 'final', 'explicit', 'template',
            'typename', 'class', 'struct', 'enum', 'namespace', 'using', 'public', 'private', 'protected',
            'vector', 'string', 'unordered_map', 'map', 'unordered_set', 'set', 'queue', 'priority_queue',
            'stack', 'deque', 'pair', 'tuple', 'list', 'bitset', 'array', 'cin', 'cout', 'endl', 'ios_base',
            'std', 'NULL', 'nullptr', 'true', 'false', 'this', 'new', 'delete', 'return', 'if', 'else', 'while',
            'for', 'do', 'switch', 'case', 'break', 'continue', 'default', 'try', 'catch', 'throw', 'sizeof',
            'def', 'elif', 'import', 'from', 'as', 'except', 'lambda', 'None', 'self',
            'boolean', 'var', 'let', 'function', 'async', 'await'
        ];
        const kwRegex = new RegExp('\\b(' + keywords.join('|') + ')\\b', 'g');
        escaped = escaped.replace(kwRegex, '<span class="token keyword">$1</span>');
        escaped = escaped.replace(/\b(\d+)\b/g, '<span class="token number">$1</span>');
        escaped = escaped.replace(/\b([a-zA-Z_]\w*)(?=\s*\()/g, '<span class="token function">$1</span>');

        // Restore strings
        escaped = escaped.replace(/___STRING_(\d+)___/g, (match, idx) => {
            return `<span class="token string">${strings[parseInt(idx)]}</span>`;
        });

        // Restore comments
        escaped = escaped.replace(/___COMMENT_(\d+)___/g, (match, idx) => {
            return `<span class="token comment">${comments[parseInt(idx)]}</span>`;
        });

        return escaped;
    }

    function injectCodeIntoEditor(code) {
        let injected = false;

        // Strategy A: Direct DOM Editor targets (Monaco inputarea / CodeMirror cm-content / textareas)
        try {
            // 1. Monaco Editor textarea inputarea
            const monacoTextArea = document.querySelector('.monaco-editor textarea.inputarea');
            if (monacoTextArea) {
                monacoTextArea.focus();
                document.execCommand('selectAll', false, null);
                document.execCommand('insertText', false, code);
                injected = true;
                console.log("Injected via Monaco DOM execCommand");
            }

            // 2. CodeMirror 6 content element
            if (!injected) {
                const cm6El = document.querySelector('.cm-content');
                if (cm6El) {
                    cm6El.focus();
                    const sel = window.getSelection();
                    const range = document.createRange();
                    range.selectNodeContents(cm6El);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    document.execCommand('insertText', false, code);
                    cm6El.dispatchEvent(new Event('input', { bubbles: true }));
                    injected = true;
                    console.log("Injected via CodeMirror 6 execCommand");
                }
            }

            // 3. CodeMirror 5 element
            if (!injected) {
                const cmEl = document.querySelector('.CodeMirror');
                if (cmEl && cmEl.CodeMirror) {
                    cmEl.CodeMirror.setValue(code);
                    injected = true;
                    console.log("Injected via CodeMirror 5 object API");
                }
            }

            // 4. Any large visible textarea
            if (!injected) {
                const textareas = document.querySelectorAll('textarea');
                for (let ta of textareas) {
                    if (ta.offsetHeight > 80 && !ta.classList.contains('assistant-chat-input-field')) {
                        ta.value = code;
                        ta.dispatchEvent(new Event('input', { bubbles: true }));
                        ta.focus();
                        injected = true;
                        console.log("Injected via textarea fallback");
                        break;
                    }
                }
            }
        } catch (e) {
            console.warn("DOM injection attempt encountered warning:", e);
        }

        // Strategy B: Inline Script Injection (attempted safely within try...catch)
        if (!injected) {
            try {
                const script = document.createElement('script');
                script.textContent = `
                    (function() {
                        try {
                            if (window.monaco && window.monaco.editor) {
                                const editors = window.monaco.editor.getEditors();
                                if (editors && editors.length > 0) {
                                    editors[0].setValue(${JSON.stringify(code)});
                                    return;
                                }
                            }
                        } catch(e) {}
                    })();
                `;
                document.documentElement.appendChild(script);
                script.remove();
            } catch (e) {
                console.log("Inline script injection restricted by CSP, using clipboard fallback");
            }
        }

        // Always copy code to clipboard as a fast fallback guarantee!
        copyToClipboard(code, null);
    }

    function escapeHtml(text) {
        if (!text) return "";
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    async function copyToClipboard(text, btnId) {
        try {
            await navigator.clipboard.writeText(text);
            if (btnId) {
                const btn = document.getElementById(btnId);
                if (btn) {
                    btn.innerText = 'Copied!';
                    btn.classList.add('copied');
                    setTimeout(() => {
                        btn.innerText = 'Copy';
                        btn.classList.remove('copied');
                    }, 2000);
                }
            }
        } catch (err) {
            console.error('Clipboard error:', err);
        }
    }

    render();
})();
