# Dark Mode 🕵️‍♂️✨ v2.1 (Google Chrome Extension - Manifest V3)

A powerful, stealthy, and intelligent Chrome Extension for automated webpage scanning, MCQ solving, and coding assistance. Powered by **Groq** (cloud, primary) and **Ollama** (local fallback).

---

## 🏗️ Chrome Extension Architecture (MV3)

```
project/
├── manifest.json      # Extension Manifest V3 configuration
├── popup.html         # Extension popup HTML layout
├── popup.js           # Extension popup script (health check & options opener)
├── popup.css          # Extension popup styles
├── background.js      # Service worker (handles tab screenshots & storage setup)
├── content.js         # Content script injected into web pages (scan UI & hotkeys)
├── styles.css         # Floating panel & code viewer styles
├── options.html       # Extension settings page (backend URL & preferences)
├── options.js         # Extension settings script using chrome.storage
├── icons/             # Chrome Extension icons
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── assets/            # Static extension resources
└── server/            # Python FastAPI backend server
    ├── main.py
    ├── requirements.txt
    └── .env.example
```

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|:----|:-------|
| **`` ` ``** (Backtick) | **Text Scan** — Scans page text for MCQs and coding questions |
| **`\`** (Backslash) | **Vision Scan** — Screenshots active tab and analyzes image using AI vision |
| **`[`** | **Toggle Minimal Mode** — Compact badge showing quick answer indicator |
| **`]`** | **Stealth Mode** — Instantly hide or show the assistant UI |

---

## 🛠️ Installation & Setup Instructions

### 1 · Load Unpacked Extension in Chrome

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click **Load unpacked** (top-left button).
4. Select the `extension-name` (or `browser_assistant_output/extension`) folder.
5. The extension will install successfully without errors.

### 2 · Options & Configuration

1. Click the extension icon in your Chrome toolbar or right-click the extension icon and select **Options**.
2. Customize the **Backend Server URL** (default: `http://localhost:8000`).
3. Set your preferred **Default Scan Mode** (`auto`, `mcq`, or `code`).
4. Click **Save Settings** to persist values via `chrome.storage.local`.

### 3 · Start Backend Server (Python)

```bash
cd server
pip install -r requirements.txt
cp .env.example .env          # Edit .env and set your GROQ_API_KEY
python main.py
```

The server starts on `http://localhost:8000`.  
Check server health at `http://localhost:8000/health` or via the popup status badge.

### 4 · Optional: Local Fallback AI (Ollama)

If Groq is unreachable, the extension automatically falls back to your local Ollama installation:

```bash
# Download Ollama: https://ollama.com
ollama pull llama3
```

---

## 🛡️ Permissions & Security

- **`activeTab` & `tabs`**: Used exclusively to capture screenshots of the current tab during **Vision Scan** (`\`).
- **`storage`**: Used to save user settings (Backend URL, Scan Mode) across browser sessions using `chrome.storage.local`.
- **`scripting`**: Allows content scripts to run seamlessly on practice pages.
- **`clipboardWrite`**: Permits one-click copying of generated code solutions to your clipboard.
- **`host_permissions`**: `http://localhost:8000/*` (Backend API communication) and `<all_urls>` (Injecting floating assistant panel).

---

*Built for Saarthi AI.*
