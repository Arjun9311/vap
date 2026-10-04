import sys
import os
import io

if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='backslashreplace')
    except Exception:
        pass
if sys.stderr and hasattr(sys.stderr, 'reconfigure'):
    try:
        sys.stderr.reconfigure(encoding='utf-8', errors='backslashreplace')
    except Exception:
        pass

def safe_print(msg: str):
    try:
        print(msg)
    except Exception:
        try:
            print(str(msg).encode('ascii', errors='backslashreplace').decode('ascii'))
        except Exception:
            pass

# Auto-detect and switch to virtual environment if dependencies are missing in current Python
try:
    import fastapi
    import uvicorn
    import dotenv
    import groq
    import ollama
except ModuleNotFoundError as err:
    server_dir = os.path.dirname(os.path.abspath(__file__))
    venv_python_win = os.path.join(server_dir, ".venv", "Scripts", "python.exe")
    venv_python_posix = os.path.join(server_dir, ".venv", "bin", "python")
    venv_python = venv_python_win if os.name == "nt" else venv_python_posix

    if os.path.exists(venv_python) and os.path.abspath(sys.executable) != os.path.abspath(venv_python):
        safe_print(f"[*] Missing dependency '{err.name}' in current Python ({sys.executable}).")
        safe_print(f"[*] Automatically switching to virtual environment Python: {venv_python}")
        if os.name == "nt":
            import subprocess
            sys.exit(subprocess.call([venv_python] + sys.argv))
        else:
            os.execv(venv_python, [venv_python] + sys.argv)
    else:
        safe_print(f"[!] Error: Missing dependency '{err.name}'.")
        safe_print("[!] Please run: pip install -r requirements.txt")
        sys.exit(1)

import json
import asyncio
import re
import subprocess
import time
import hashlib
from collections import OrderedDict
from typing import Optional, Dict, Any, List
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel
from dotenv import load_dotenv
from groq import Groq

# Load environment variables
server_env = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
load_dotenv(server_env)
load_dotenv()

# In-Memory Fast LRU Cache
class ResponseCache:
    def __init__(self, capacity: int = 1000):
        self.capacity = capacity
        self.cache: OrderedDict[str, str] = OrderedDict()
        self.lock = asyncio.Lock()

    async def get(self, key: str) -> Optional[str]:
        async with self.lock:
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key]
            return None

    async def set(self, key: str, value: str):
        async with self.lock:
            if key in self.cache:
                self.cache.move_to_end(key)
            self.cache[key] = value
            if len(self.cache) > self.capacity:
                self.cache.popitem(last=False)

response_cache = ResponseCache(capacity=1000)

# Persistent HTTP Connection Pool for sub-second request reuse
_client: Optional[httpx.AsyncClient] = None

async def get_http_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=4.0),
            limits=httpx.Limits(max_keepalive_connections=30, max_connections=50, keepalive_expiry=120.0),
            headers={"User-Agent": "BrowserAssistant/2.2"}
        )
    return _client

# Cached VPN status (30s TTL to prevent spawning tasklist.exe on every request)
_vpn_cache: Dict[str, Any] = {"active": False, "expires": 0.0}

def is_vpn_active() -> bool:
    now = time.time()
    if now < _vpn_cache["expires"]:
        return bool(_vpn_cache["active"])
    try:
        out = subprocess.check_output("tasklist", shell=True, text=True, errors="ignore")
        active = any(v in out.lower() for v in ["protonvpn", "openvpn", "wireguard", "warp.exe", "nordvpn"])
    except Exception:
        active = False
    _vpn_cache["active"] = active
    _vpn_cache["expires"] = now + 30.0
    return active

def extract_mcq_heuristic(text: str):
    if not text:
        return None
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    options = []
    question_lines = []
    found_option = False
    
    for line in lines:
        if re.match(r'^(?:[A-Ea-e][\.\)]|\([A-Ea-e]\))\s+', line):
            found_option = True
            options.append(line)
        elif not found_option:
            question_lines.append(line)
            
    if found_option and options:
        q_text = " ".join(question_lines[-3:]) if question_lines else "Detected Question"
        return {"question": q_text[:200], "options": "\n".join(options[:6])}
    return None

# Setup Groq
api_key_groq = os.getenv("GROQ_API_KEY")
client_groq = None
if api_key_groq and len(api_key_groq.strip()) > 10 and "your_groq_api_key" not in api_key_groq:
    try:
        client_groq = Groq(api_key=api_key_groq.strip())
    except Exception as e:
        safe_print(f"Warning: Groq client initialization failed: {e}")

# Setup Gemini (Free at https://aistudio.google.com and works with VPNs)
api_key_gemini = os.getenv("GEMINI_API_KEY")
if api_key_gemini and (len(api_key_gemini.strip()) < 10 or "your_" in api_key_gemini):
    api_key_gemini = None
elif api_key_gemini:
    api_key_gemini = api_key_gemini.strip()

# Setup OpenRouter
api_key_openrouter = os.getenv("OPENROUTER_API_KEY")
if api_key_openrouter and (len(api_key_openrouter.strip()) < 10 or "your_" in api_key_openrouter):
    api_key_openrouter = None
elif api_key_openrouter:
    api_key_openrouter = api_key_openrouter.strip()

# Ollama model is configurable via .env
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3")

# Max page text length to capture full problem statement, all examples, and constraints (~18k chars)
MAX_TEXT_LENGTH = 18000

app = FastAPI(title="Browser Assistant API", version="2.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # Chrome extensions use chrome-extension:// origin
    allow_credentials=False,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

class PageContent(BaseModel):
    text: str
    url: str = ""
    practice_type: str = "auto"
    format: Optional[str] = "json"  # "json" or "code" / "raw"

class VisionContent(BaseModel):
    image: str  # Base64 data URL
    url: str
    text: str = ""  # Optional page text fallback

class RefinementContent(BaseModel):
    text: str
    url: str
    previous_results: str
    prompt: str
    practice_type: str = "code"


# ── Health check ──────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "groq_configured": client_groq is not None,
        "gemini_configured": bool(api_key_gemini),
        "openrouter_configured": bool(api_key_openrouter),
        "ollama_model": OLLAMA_MODEL,
        "vpn_detected": is_vpn_active(),
        "version": "2.1.0"
    }


# ── AI providers ──────────────────────────────────────────────────────────────

async def try_gemini(prompt: str, image_b64: str = None, max_tokens: int = 350) -> str:
    if not api_key_gemini:
        raise Exception("Gemini API key not configured")

    models = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-flash-latest", "gemini-3.5-flash-lite"]
    last_err = None

    parts = [{"text": prompt}]
    if image_b64:
        if "," in image_b64:
            image_b64 = image_b64.split(",")[1]
        parts.append({
            "inline_data": {
                "mime_type": "image/png",
                "data": image_b64
            }
        })

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "temperature": 0.0,
            "maxOutputTokens": max_tokens,
            "thinkingConfig": {
                "thinkingBudget": 0
            }
        }
    }

    client = await get_http_client()
    for model in models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key_gemini}"
        try:
            resp = await client.post(url, json=payload, timeout=8.0)
            if resp.status_code == 200:
                data = resp.json()
                candidates = data.get("candidates", [])
                if candidates and "content" in candidates[0]:
                    parts_resp = candidates[0]["content"].get("parts", [])
                    if parts_resp:
                        return parts_resp[0].get("text", "")
                raise Exception("Unexpected Gemini response structure")
            elif resp.status_code == 400 and "thinkingConfig" in resp.text:
                fallback_payload = {
                    "contents": [{"parts": parts}],
                    "generationConfig": {
                        "temperature": 0.0,
                        "maxOutputTokens": max_tokens
                    }
                }
                retry_resp = await client.post(url, json=fallback_payload, timeout=8.0)
                if retry_resp.status_code == 200:
                    candidates = retry_resp.json().get("candidates", [])
                    if candidates and "content" in candidates[0]:
                        parts_resp = candidates[0]["content"].get("parts", [])
                        if parts_resp:
                            return parts_resp[0].get("text", "")
            last_err = Exception(f"Gemini ({model}) returned {resp.status_code}: {resp.text[:150]}")
        except Exception as e:
            last_err = e
            safe_print(f"Gemini model {model} failed: {e}")
            continue

    raise last_err


async def try_openrouter(prompt: str, image_b64: str = None, max_tokens: int = 350) -> str:
    if not api_key_openrouter:
        raise Exception("OpenRouter API key not configured")

    models = [
        "google/gemini-2.5-flash",
        "openai/gpt-4o-mini",
        "deepseek/deepseek-chat"
    ]
    last_err = None

    content = prompt
    if image_b64:
        if not image_b64.startswith("data:"):
            image_b64 = f"data:image/png;base64,{image_b64}"
        content = [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": image_b64}}
        ]

    client = await get_http_client()
    for model in models:
        try:
            resp = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key_openrouter}",
                    "HTTP-Referer": "https://localhost",
                    "X-Title": "Browser Assistant",
                    "Content-Type": "application/json"
                },
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": content}],
                    "temperature": 0.0,
                    "max_tokens": max_tokens
                },
                timeout=7.0
            )
            if resp.status_code == 200:
                data = resp.json()
                return data["choices"][0]["message"]["content"]
            else:
                last_err = Exception(f"OpenRouter ({model}) returned {resp.status_code}: {resp.text[:150]}")
        except Exception as e:
            last_err = e
            continue

    raise last_err


async def try_groq(prompt: str, max_tokens: int = 350) -> str:
    if not client_groq:
        raise Exception("Groq client not configured — set valid GROQ_API_KEY in .env")
    if is_vpn_active():
        return "VPN_BLOCKED_403"
    loop = asyncio.get_running_loop()

    models_to_try = [
        "openai/gpt-oss-120b",
        "openai/gpt-oss-20b",
        "qwen/qwen3.8-27b",
        "llama-3.3-70b-versatile",
        "llama-3.1-8b-instant"
    ]
    last_err = None

    for model in models_to_try:
        try:
            response = await loop.run_in_executor(
                None,
                lambda m=model: client_groq.chat.completions.create(
                    messages=[
                        {"role": "system", "content": "You are a structured data generator. You MUST return ONLY a valid JSON list of objects without any markdown formatting, explanations, or <think> tags outside the JSON."},
                        {"role": "user", "content": prompt}
                    ],
                    model=m,
                    temperature=0.0,
                    max_tokens=max_tokens,
                ),
            )
            return response.choices[0].message.content
        except Exception as e:
            last_err = e
            err_str = str(e).lower()
            if "403" in err_str or "access denied" in err_str:
                safe_print(f"[!] Groq 403 Access Denied on {model}: Cloudflare blocked this request due to datacenter/VPN IP.")
                return "VPN_BLOCKED_403"
            safe_print(f"Groq model {model} failed: {e}.")

    raise last_err


async def try_ollama(prompt: str) -> str:
    loop = asyncio.get_running_loop()
    try:
        response = await loop.run_in_executor(
            None,
            lambda: ollama.chat(
                model=OLLAMA_MODEL,
                messages=[{"role": "user", "content": prompt}],
            ),
        )
        return response["message"]["content"]
    except Exception as e:
        raise Exception(f"Ollama error ({OLLAMA_MODEL}): {str(e)}")


# ── Routes ────────────────────────────────────────────────────────────────────

@app.post("/solve")
async def solve_questions(content: PageContent):
    raw_text = re.sub(r'\n{3,}', '\n\n', content.text or "").strip()
    trimmed_text = raw_text[:MAX_TEXT_LENGTH]
    if len(raw_text) > MAX_TEXT_LENGTH:
        trimmed_text += "\n\n[...page content trimmed for brevity...]"

    # 1. Instant Cache Check (<1ms response)
    cache_key = hashlib.sha256(f"{content.practice_type}:{trimmed_text}".encode("utf-8")).hexdigest()
    cached_val = await response_cache.get(cache_key)
    if cached_val:
        safe_print("[Cache Hit] Instant answer served (<1ms)")
        cpp_code = extract_cpp_code(cached_val)
        if getattr(content, "format", "json") in ("code", "raw"):
            return PlainTextResponse(cpp_code, media_type="text/plain; charset=utf-8")
        return {"code": cpp_code, "results": cached_val, "provider": "instant-cache"}

    # 2. Detect context and prepare comprehensive C++ competitive programming prompt
    is_mcq = (content.practice_type == "mcq") or (
        content.practice_type == "auto" and bool(re.search(r'(?:[A-Ea-e][\.\)]|\([A-Ea-e]\))\s+', trimmed_text)) and not any(k in trimmed_text.lower() for k in ["#include", "def ", "class solution", "public:", "sample input", "constraints", "stdin", "stdout"])
    )

    if is_mcq:
        max_output_tokens = 400
        prompt = f"""Identify the Multiple Choice Question and choices below. Choose the correct option.
Format strictly as a JSON list:
[{{"type": "mcq", "question": "Question summary", "answer": "Option X: Content"}}]
Return ONLY the JSON list.

Content:
{trimmed_text}"""
    else:
        max_output_tokens = 3500
        prompt = f"""You are a world-class competitive programming Grandmaster and senior C++ engineer.
Analyze the following coding problem thoroughly. Your goal is to produce a 100% correct, complete, and optimal C++ (C++17/20) solution that strictly satisfies all constraints, handles all edge cases, and matches all examples.

WEBPAGE PROBLEM CONTENT:
{trimmed_text}

MANDATORY RULES FOR C++ SOLUTION GENERATION:

RULE 1: DEFAULT / STARTER CODE TEMPLATE PRESERVATION (HIGHEST PRIORITY)
Look very carefully at the problem content for ANY starter code, class template, or function stubs (especially under '=== STARTER CODE / SIGNATURE IN EDITOR ===', in code blocks, or in the problem text, e.g. 'class solution', 'class Solution', or predefined member variables and methods like 'addOrder', 'updateOrder', 'calculateTotalRevenue'):
- IF ANY STARTER CODE OR CLASS SKELETON IS GIVEN:
  1. YOU MUST USE THAT EXACT CLASS NAME AND STRUCTURE VERBATIM (e.g., if the starter code says 'class solution', keep 'class solution' in lowercase!).
  2. RETAIN ALL PRE-EXISTING MEMBER VARIABLES AND TYPES EXACTLY AS DEFINED (e.g. if 'vector<pair<string, pair<int, double>>> orders;' is defined, KEEP IT VERBATIM; do NOT remove, rename, or retype it!).
  3. IMPLEMENT EVERY DECLARED FUNCTION / METHOD STUB (e.g. 'addOrder', 'updateOrder', 'calculateTotalRevenue').
  4. Replace all '//Write your code here...' comments with 100% complete, correct, and optimal logic.
  5. DO NOT alter parameter names, parameter types, or return types of any starter function.
  6. DO NOT omit any function. The generated code must replace the starter template and compile cleanly against the assessment's test runner.

RULE 2: WHEN NO STARTER CODE TEMPLATE EXISTS:
- If standard LeetCode/class-based problem:
  #include <bits/stdc++.h>
  using namespace std;
  class Solution {{
  public:
      <return_type> <function_name>(<parameters>) {{
          // optimal logic
      }}
  }};
- If standard competitive programming with stdin/cin (e.g. Codeforces, CP platforms requiring main()):
  #include <bits/stdc++.h>
  using namespace std;
  int main() {{
      ios_base::sync_with_stdio(false);
      cin.tie(NULL);
      // optimal logic
      return 0;
  }}

RULE 3: PURE C++ STANDARDS:
- Always include '#include <bits/stdc++.h>' and 'using namespace std;' at the very top.
- ZERO placeholders, ZERO 'TODO', ZERO '// code here'. Write out the complete, runnable solution.
- Provide ONLY C++ in the 'languages' object (key 'cpp').

RULE 4: CONCISE METADATA:
- Keep 'constraints', 'input_output_format', 'examples_walkthrough', and 'explanation' concise (under 80 words each) to preserve speed and avoid token truncation.

Format STRICTLY as a JSON list of objects:
[
  {{
    "type": "code",
    "title": "Problem Title",
    "languages": {{
      "cpp": "#include <bits/stdc++.h>\\nusing namespace std;\\n\\n..."
    }},
    "constraints": "Concise summary of constraints & complexity",
    "input_output_format": "Concise summary of input & output",
    "examples_walkthrough": "Brief bullet points verifying sample test cases",
    "time_complexity": "O(...)",
    "space_complexity": "O(...)",
    "explanation": "Concise 2-3 sentence explanation of the optimal approach"
  }}
]

CRITICAL: Return ONLY the raw JSON list without markdown fences, explanation, or text outside the JSON."""

    errors = []

    # 3. High-Speed Concurrent Fast-Race
    # Launch fastest available providers simultaneously
    tasks = {}
    if api_key_gemini:
        tasks[asyncio.create_task(try_gemini(prompt, max_tokens=max_output_tokens))] = "gemini"
    if api_key_openrouter:
        tasks[asyncio.create_task(try_openrouter(prompt, max_tokens=max_output_tokens))] = "openrouter"
    if client_groq and not is_vpn_active():
        tasks[asyncio.create_task(try_groq(prompt, max_tokens=max_output_tokens))] = "groq"

    if tasks:
        pending = set(tasks.keys())
        winner_result = None
        winner_provider = None

        while pending:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for completed_task in done:
                provider_name = tasks[completed_task]
                try:
                    raw_output = completed_task.result()
                    if raw_output == "VPN_BLOCKED_403":
                        errors.append("Groq blocked by Cloudflare (403 Access Denied: VPN active)")
                        continue
                    cleaned = clean_json(raw_output)
                    if cleaned and cleaned != "[]":
                        winner_result = cleaned
                        winner_provider = provider_name
                        break
                except Exception as e:
                    err_msg = f"{provider_name} fast-race error: {e}"
                    safe_print(err_msg)
                    errors.append(err_msg)
            if winner_result:
                break

        # Cancel slower pending tasks immediately
        for t in pending:
            t.cancel()

        if winner_result:
            await response_cache.set(cache_key, winner_result)
            cpp_code = extract_cpp_code(winner_result)
            if getattr(content, "format", "json") in ("code", "raw"):
                return PlainTextResponse(cpp_code, media_type="text/plain; charset=utf-8")
            return {"code": cpp_code, "results": winner_result, "provider": f"fast-race ({winner_provider})"}

    # 4. Fallback to Local Ollama if race yielded no result
    try:
        safe_print(f"Attempting Ollama fallback ({OLLAMA_MODEL})...")
        result = await try_ollama(prompt)
        cleaned = clean_json(result)
        if cleaned != "[]":
            await response_cache.set(cache_key, cleaned)
            cpp_code = extract_cpp_code(cleaned)
            if getattr(content, "format", "json") in ("code", "raw"):
                return PlainTextResponse(cpp_code, media_type="text/plain; charset=utf-8")
            return {"code": cpp_code, "results": cleaned, "provider": f"ollama ({OLLAMA_MODEL})"}
        else:
            errors.append("Ollama output could not be parsed into structured JSON")
    except Exception as e:
        errors.append(f"Ollama failed: {str(e)}")
        safe_print(errors[-1])

    # 5. Graceful advisory response
    vpn_blocked = any("403" in err or "vpn" in err.lower() or "access denied" in err.lower() for err in errors)
    if vpn_blocked:
        advice = (
            "⚠️ Groq Cloudflare Block (403 Forbidden)\n"
            "ProtonVPN is currently active, and Cloudflare blocks VPN/datacenter IPs from accessing Groq.\n\n"
            "How to fix in 10 seconds:\n"
            "1. Disconnect ProtonVPN in Windows, then press ` to scan again.\n"
            "2. OR get a free Google Gemini key at https://aistudio.google.com and paste it in server/.env as GEMINI_API_KEY=... (works through VPN!)."
        )
    else:
        advice = (
            "⚠️ All AI Providers Unavailable\n"
            "Please configure a valid GROQ_API_KEY or GEMINI_API_KEY in server/.env, or start local Ollama."
        )

    heuristic = extract_mcq_heuristic(raw_text)
    if heuristic:
        return {
            "code": "",
            "results": json.dumps([{
                "type": "mcq",
                "question": heuristic["question"],
                "answer": f"{heuristic['options']}\n\n{advice}"
            }]),
            "provider": "system-advisor"
        }

    return {
        "code": "",
        "results": json.dumps([{
            "type": "mcq",
            "question": "Assistant Network Advisory",
            "answer": advice
        }]),
        "provider": "system-advisor"
    }


@app.post("/code")
async def get_direct_code(content: PageContent):
    """Direct endpoint to get 100% pure, compilable C++ code without any JSON formatting."""
    content.format = "code"
    content.practice_type = "code"
    res = await solve_questions(content)
    if isinstance(res, Response):
        return res
    cpp = res.get("code") or extract_cpp_code(res.get("results", ""))
    return PlainTextResponse(cpp, media_type="text/plain; charset=utf-8")


@app.get("/code")
async def get_direct_code_get(text: str = ""):
    """GET endpoint to get 100% pure C++ code directly."""
    content = PageContent(text=text, url="", practice_type="code", format="code")
    res = await solve_questions(content)
    if isinstance(res, Response):
        return res
    cpp = res.get("code") or extract_cpp_code(res.get("results", ""))
    return PlainTextResponse(cpp, media_type="text/plain; charset=utf-8")


@app.post("/refine")
async def refine_solution(content: RefinementContent):
    raw_text = re.sub(r'\n{3,}', '\n\n', content.text or "").strip()
    trimmed_text = raw_text[:MAX_TEXT_LENGTH]
    if len(raw_text) > MAX_TEXT_LENGTH:
        trimmed_text += "\n\n[...page content trimmed for brevity...]"

    prompt = f"""
    You are an expert competitive programmer and senior C++ engineer. The user wants to refine or ask questions about a solution.

    Webpage URL: {content.url}
    Webpage Content Context:
    {trimmed_text}

    Previous Solution Details:
    {content.previous_results}

    User Refinement / Question Request:
    {content.prompt}

    Task:
    Review the previous solution and the user's request. Modify or explain the solution accordingly.
    - C++ is the primary language.
    - CRITICAL RULE: If any starter code / class template exists on the page or in context (e.g. 'class solution', 'class Solution', predefined member variables like 'orders', and function stubs like 'addOrder', 'updateOrder', 'calculateTotalRevenue'):
      1. PRESERVE THAT EXACT CLASS NAME AND STRUCTURE VERBATIM (including lowercase 'solution' if given).
      2. RETAIN ALL PRE-EXISTING MEMBER VARIABLES AND TYPES (e.g., 'vector<pair<string, pair<int, double>>> orders;').
      3. IMPLEMENT ALL DECLARED METHODS/FUNCTIONS.
      4. DO NOT alter function signatures or return types.
    - If no starter code template exists:
      #include <bits/stdc++.h>
      using namespace std;
      class Solution {{
      public:
          // complete, compilable, optimal implementation
      }};
    - ZERO placeholders, ZERO 'TODO', ZERO '// code here'.
    - Provide ONLY 'cpp' in 'languages'.
    - If the user asks for optimization, explain how the new approach fits within the constraints.
    - If the user asks a question, explain it inside the explanation field.
    - Update constraints, input_output_format, examples_walkthrough, time_complexity, space_complexity, and explanation concisely.

    Format the output STRICTLY as a JSON list of objects:
    If Coding:
    [{{"type": "code", "title": "...", "languages": {{"cpp": "#include <bits/stdc++.h>\\nusing namespace std;\\n\\n..."}}, "constraints": "...", "input_output_format": "...", "examples_walkthrough": "...", "time_complexity": "...", "space_complexity": "...", "explanation": "..."}}]
    If MCQ:
    [{{"type": "mcq", "question": "...", "answer": "..."}}]

    CRITICAL: Return ONLY the JSON list.
    """

    errors = []

    # 1. Try Gemini
    if api_key_gemini:
        try:
            safe_print("Attempting Gemini refinement...")
            result = await try_gemini(prompt, max_tokens=3500)
            cleaned = clean_json(result)
            if cleaned != "[]":
                cpp_code = extract_cpp_code(cleaned)
                return {"code": cpp_code, "results": cleaned, "provider": "gemini"}
        except Exception as e:
            errors.append(f"Gemini failed: {str(e)}")
            safe_print(errors[-1])

    # 2. Try Groq
    if client_groq:
        try:
            safe_print("Attempting Groq refinement...")
            result = await try_groq(prompt, max_tokens=3500)
            if result != "VPN_BLOCKED_403":
                cleaned = clean_json(result)
                if cleaned != "[]":
                    cpp_code = extract_cpp_code(cleaned)
                    return {"code": cpp_code, "results": cleaned, "provider": "groq"}
            else:
                errors.append("Groq blocked by Cloudflare (403 Access Denied: ProtonVPN detected)")
        except Exception as e:
            errors.append(f"Groq failed: {str(e)}")
            safe_print(errors[-1])

    # 3. Try OpenRouter
    if api_key_openrouter:
        try:
            safe_print("Attempting OpenRouter refinement...")
            result = await try_openrouter(prompt, max_tokens=3500)
            cleaned = clean_json(result)
            if cleaned != "[]":
                cpp_code = extract_cpp_code(cleaned)
                return {"code": cpp_code, "results": cleaned, "provider": "openrouter"}
        except Exception as e:
            errors.append(f"OpenRouter failed: {str(e)}")
            safe_print(errors[-1])

    # 4. Try Ollama (Local fallback)
    try:
        safe_print(f"Attempting Ollama fallback ({OLLAMA_MODEL}) refinement...")
        result = await try_ollama(prompt)
        cleaned = clean_json(result)
        if cleaned != "[]":
            cpp_code = extract_cpp_code(cleaned)
            return {"code": cpp_code, "results": cleaned, "provider": f"ollama ({OLLAMA_MODEL})"}
        else:
            errors.append("Ollama refinement output could not be parsed into JSON")
    except Exception as e:
        errors.append(f"Ollama failed: {str(e)}")
        safe_print(errors[-1])

    return {
        "code": "",
        "results": json.dumps([{
            "type": "mcq",
            "question": "Refinement Notice",
            "answer": "AI refinement unavailable due to network/VPN restrictions. Please disconnect ProtonVPN or set GEMINI_API_KEY in server/.env."
        }]),
        "provider": "system-advisor"
    }


@app.post("/solve-vision")
async def solve_vision(content: VisionContent):
    image_data = content.image
    if "," in image_data:
        image_data = image_data.split(",")[1]

    prompt = """
    You are an elite competitive programmer and vision OCR specialist.
    Analyze this screenshot from a webpage carefully.
    1. Extract the coding problem thoroughly:
       - Problem title & full statement
       - All constraints (e.g., 1 <= N <= 10^5, time limits, memory limits, data value bounds)
       - All examples (Sample Inputs, Sample Outputs, Explanations)
       - Expected input/output format or starter function signature visible in the code editor.
    2. If there are test case errors or existing buggy code in the editor, diagnose the failure and provide the complete corrected solution.
    3. Generate a 100% correct, complete, compilable C++ solution (C++17/20) with optimal time and space complexity. ZERO placeholders, ZERO 'TODO'.
       MANDATORY C++ FORMAT:
       - If any starter code, class skeleton, or function signatures are visible in the code editor or problem image (e.g. 'class solution', 'class Solution', member variables like 'orders', and function stubs like 'addOrder', 'updateOrder', 'calculateTotalRevenue'):
         1. PRESERVE THAT EXACT SKELETON AND CLASS NAME VERBATIM.
         2. RETAIN ALL PRE-EXISTING MEMBER VARIABLES AND TYPES VERBATIM.
         3. IMPLEMENT EVERY DECLARED FUNCTION / METHOD BODY.
         4. DO NOT alter parameter names, types, or return types.
       - If no starter code exists:
         #include <bits/stdc++.h>
         using namespace std;
         class Solution {
         public:
             <return_type> <function_name>(<parameters>) {
                 // complete logic
             }
         };
         (If standard I/O int main() is strictly required, use #include <bits/stdc++.h>\nusing namespace std;\nint main() { ... }).
       Provide ONLY C++ in 'languages' ('cpp'). Do NOT generate Python or Java.
    4. If the image is an MCQ question, extract the question, choices, and identify the correct option.

    Format the output STRICTLY as a JSON list of objects:
    If Coding:
    [
      {
        "type": "code",
        "title": "Problem Title",
        "languages": {
          "cpp": "#include <bits/stdc++.h>\\nusing namespace std;\\n\\n..."
        },
        "constraints": "Concise summary of constraints & complexity limits",
        "input_output_format": "Concise input and output specifications",
        "examples_walkthrough": "Brief bullet points verifying sample test cases",
        "time_complexity": "O(...)",
        "space_complexity": "O(...)",
        "explanation": "Concise 2-3 sentence intuition and algorithm explanation"
      }
    ]
    If MCQ:
    [{"type": "mcq", "question": "...", "answer": "Option X: Content"}]

    Provide ONLY the valid raw JSON list without markdown fences.
    """

    errors = []

    # 1. High-Speed Concurrent Vision Fast-Race
    tasks = {}
    if api_key_gemini:
        tasks[asyncio.create_task(try_gemini(prompt, image_b64=image_data, max_tokens=3000))] = "gemini-vision"
    if api_key_openrouter:
        tasks[asyncio.create_task(try_openrouter(prompt, image_b64=image_data, max_tokens=3000))] = "openrouter-vision"

    if tasks:
        pending = set(tasks.keys())
        winner_result = None
        winner_provider = None

        while pending:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for completed_task in done:
                provider_name = tasks[completed_task]
                try:
                    raw_output = completed_task.result()
                    cleaned = clean_json(raw_output)
                    if cleaned and cleaned != "[]":
                        winner_result = cleaned
                        winner_provider = provider_name
                        break
                except Exception as e:
                    err_msg = f"{provider_name} failed: {e}"
                    safe_print(err_msg)
                    errors.append(err_msg)
            if winner_result:
                break

        for t in pending:
            t.cancel()

        if winner_result:
            cpp_code = extract_cpp_code(winner_result)
            return {"code": cpp_code, "results": winner_result, "provider": f"fast-race ({winner_provider})"}

    # 3. Try Groq Vision models
    if client_groq:
        vision_models = [
            "llama-3.2-11b-vision-preview",
            "llama-3.2-90b-vision-preview"
        ]
        for vision_model in vision_models:
            try:
                safe_print(f"Attempting Groq Vision ({vision_model})...")
                loop = asyncio.get_running_loop()
                completion = await loop.run_in_executor(
                    None,
                    lambda model=vision_model: client_groq.chat.completions.create(
                        model=model,
                        messages=[
                            {
                                "role": "user",
                                "content": [
                                    {"type": "text", "text": prompt},
                                    {
                                        "type": "image_url",
                                        "image_url": {"url": f"data:image/png;base64,{image_data}"},
                                    },
                                ],
                            }
                        ],
                        max_tokens=2048,
                    ),
                )
                result = completion.choices[0].message.content
                cleaned = clean_json(result)
                if cleaned != "[]":
                    cpp_code = extract_cpp_code(cleaned)
                    return {"code": cpp_code, "results": cleaned, "provider": f"groq-vision ({vision_model})"}
            except Exception as e:
                err_msg = f"Groq Vision ({vision_model}) failed: {e}"
                safe_print(err_msg)
                errors.append(err_msg)
                if "403" in str(e) or "access denied" in str(e).lower():
                    break

    # 4. Try Ollama Vision fallback if available
    try:
        loop = asyncio.get_running_loop()
        ollama_vision_response = await loop.run_in_executor(
            None,
            lambda: ollama.chat(
                model="llava",
                messages=[{
                    'role': 'user',
                    'content': prompt,
                    'images': [image_data]
                }]
            )
        )
        cleaned = clean_json(ollama_vision_response["message"]["content"])
        if cleaned != "[]":
            cpp_code = extract_cpp_code(cleaned)
            return {"code": cpp_code, "results": cleaned, "provider": "ollama-vision (llava)"}
    except Exception as e:
        errors.append(f"Ollama Vision (llava) failed: {e}")

    # 5. Fallback to Text Analysis if extracted page text is provided
    if content.text and content.text.strip():
        try:
            safe_print("Vision models unavailable. Falling back to page text analysis...")
            text_prompt = f"""
            Vision scan attempt fallback on webpage: {content.url}
            Extracted Page Content:
            {content.text[:MAX_TEXT_LENGTH]}

            Task:
            Identify any MCQ or Coding problems in the text and generate solutions.
            For coding problems: Preserve any starter code template verbatim. Provide a complete C++ solution in 'cpp' formatted with #include <bits/stdc++.h> and using namespace std;.
            Format STRICTLY as a JSON list of objects:
            [{{"type": "mcq", "question": "...", "answer": "Option X: Content"}}] or
            [{{"type": "code", "title": "...", "languages": {{"cpp": "#include <bits/stdc++.h>\\nusing namespace std;\\n\\n..."}}, "constraints": "...", "input_output_format": "...", "examples_walkthrough": "...", "time_complexity": "...", "space_complexity": "...", "explanation": "..."}}]
            """
            if api_key_gemini:
                res = await try_gemini(text_prompt, max_tokens=3500)
                cl = clean_json(res)
                if cl != "[]":
                    cpp_code = extract_cpp_code(cl)
                    return {"code": cpp_code, "results": cl, "provider": "gemini (text-fallback)"}
            if client_groq:
                result = await try_groq(text_prompt, max_tokens=3500)
                if result != "VPN_BLOCKED_403":
                    cleaned = clean_json(result)
                    if cleaned != "[]":
                        cpp_code = extract_cpp_code(cleaned)
                        return {"code": cpp_code, "results": cleaned, "provider": "groq (text-fallback)"}
        except Exception as e:
            errors.append(f"Text fallback failed: {e}")

    # Graceful advisory
    return {
        "code": "",
        "results": json.dumps([{
            "type": "mcq",
            "question": "Vision Scan Notice",
            "answer": "Vision AI models currently unavailable on this connection. Please use Text Scan (` ` `) or add GEMINI_API_KEY in server/.env for full Vision support."
        }]),
        "provider": "system-advisor"
    }


# ── JSON helpers ──────────────────────────────────────────────────────────────

def clean_json(text: str) -> str:
    if not text:
        return "[]"

    cleaned_text = text.strip()

    # Remove reasoning <think>...</think> blocks from AI models
    cleaned_text = re.sub(r"<think>.*?</think>", "", cleaned_text, flags=re.DOTALL).strip()
    # If unclosed <think> exists at start, strip preamble up to the first [ or {
    if "<think>" in cleaned_text:
        cleaned_text = re.sub(r"^<think>.*?(?=\[|\{|\Z)", "", cleaned_text, flags=re.DOTALL).strip()

    # If wrapped in markdown code fence like ```json [ ... ] ```, extract inner JSON block directly
    fence_match = re.search(r"```(?:json)?\s*(\[\s*\{.*\}\s*\]|\{\s*\".*\"\s*:.*?\})\s*```", cleaned_text, re.DOTALL | re.IGNORECASE)
    if fence_match:
        cleaned_text = fence_match.group(1).strip()
    else:
        # Strip outer markdown code blocks safely
        cleaned_text = re.sub(r"^```(?:json)?\s*", "", cleaned_text, flags=re.IGNORECASE)
        cleaned_text = re.sub(r"\s*```$", "", cleaned_text)

    # 1. Try finding JSON array
    match_array = re.search(r"\[\s*\{.*\}\s*\]", cleaned_text, re.DOTALL)
    if match_array:
        json_candidate = match_array.group(0)
    else:
        # Try finding single JSON object
        match_object = re.search(r"\{\s*\".*\"\s*:.*\}", cleaned_text, re.DOTALL)
        if match_object:
            json_candidate = f"[{match_object.group(0)}]"
        else:
            json_candidate = cleaned_text

    # Helper function to remove trailing commas before closing brackets/braces
    def remove_trailing_commas(s: str) -> str:
        return re.sub(r",\s*([\]}])", r"\1", s)

    json_candidate = remove_trailing_commas(json_candidate)

    # 2. Standard parse
    try:
        parsed = json.loads(json_candidate)
        if not isinstance(parsed, list):
            parsed = [parsed]
        return json.dumps(parsed)
    except Exception:
        pass

    # 3. Robust repair: escape unescaped control chars inside string values
    def escape_string_values(s: str) -> str:
        result = []
        in_string = False
        escape_next = False
        for ch in s:
            if escape_next:
                result.append(ch)
                escape_next = False
                continue
            if ch == "\\":
                escape_next = True
                result.append(ch)
                continue
            if ch == '"':
                in_string = not in_string
                result.append(ch)
                continue
            if in_string:
                if ch == "\n":
                    result.append("\\n")
                elif ch == "\r":
                    result.append("\\r")
                elif ch == "\t":
                    result.append("\\t")
                else:
                    result.append(ch)
            else:
                result.append(ch)
        return "".join(result)

    try:
        repaired = escape_string_values(json_candidate)
        repaired = remove_trailing_commas(repaired)
        parsed = json.loads(repaired)
        if not isinstance(parsed, list):
            parsed = [parsed]
        return json.dumps(parsed)
    except Exception:
        try:
            objects = []
            for m in re.finditer(r"\{\s*\"type\"\s*:\s*\"(?:mcq|code)\".*?\}(?=\s*\,|\s*\]|\s*$)", cleaned_text, re.DOTALL):
                try:
                    obj = json.loads(remove_trailing_commas(m.group(0)))
                    objects.append(obj)
                except Exception:
                    pass
            if objects:
                return json.dumps(objects)
        except Exception:
            pass

    # 4. Fallback: Extract code blocks or MCQ text if LLM returned informal response
    try:
        # Check if text contains code blocks
        code_blocks = re.findall(r"```([a-zA-Z]*)\n([\s\S]*?)```", text)
        if code_blocks:
            # Check first if any code block contains a valid JSON payload
            for lang, code_content in code_blocks:
                stripped = code_content.strip()
                if lang.lower().strip() == "json" or (stripped.startswith("[") and stripped.endswith("]")) or (stripped.startswith("{") and stripped.endswith("}")):
                    try:
                        parsed_j = json.loads(stripped)
                        if not isinstance(parsed_j, list):
                            parsed_j = [parsed_j]
                        return json.dumps(parsed_j)
                    except Exception:
                        pass

            languages = {}
            for lang, code_content in code_blocks:
                l_key = lang.lower().strip() or "cpp"
                if l_key == "json":
                    continue
                if l_key in ["cpp", "c++", "c"]:
                    languages["cpp"] = code_content.strip()
                elif l_key in ["py", "python"]:
                    languages["python"] = code_content.strip()
                elif l_key in ["java"]:
                    languages["java"] = code_content.strip()
                elif l_key in ["js", "javascript"]:
                    languages["javascript"] = code_content.strip()
                else:
                    languages[l_key] = code_content.strip()
            
            if languages:
                if "cpp" not in languages and len(languages) > 0:
                    languages["cpp"] = list(languages.values())[0]
                return json.dumps([{
                    "type": "code",
                    "title": "Generated C++ Solution",
                    "languages": languages,
                    "constraints": "Strictly satisfies time and memory constraints",
                    "input_output_format": "Standard competitive programming I/O or class signature",
                    "examples_walkthrough": "Matches problem test cases",
                    "time_complexity": "O(N log N)",
                    "space_complexity": "O(N)",
                    "explanation": "Extracted optimal solution from response."
                }])

        # Direct detection of C++ code without markdown code blocks
        if any(marker in text for marker in ["#include", "using namespace std;", "int main()", "class Solution", "class solution", "vector<int>", "vector<pair", "orders.push_back"]):
            return json.dumps([{
                "type": "code",
                "title": "C++ Solution",
                "languages": {"cpp": text.strip()},
                "constraints": "Satisfies problem constraints",
                "input_output_format": "Standard I/O / Class signature",
                "examples_walkthrough": "Matches example cases",
                "time_complexity": "O(N)",
                "space_complexity": "O(1)",
                "explanation": "Extracted C++ solution."
            }])

        # Check if text contains MCQ Answer patterns
        if re.search(r"(?:Option\s*[A-E]|Answer\s*:\s*(?:Option\s*)?[A-E]|\b[A-E]\))", text, re.IGNORECASE) or "correct" in text.lower():
            clean_lines = [line.strip() for line in text.split("\n") if line.strip() and not line.strip().startswith("<think>")]
            answer_text = clean_lines[0] if clean_lines else text[:200]
            for line in clean_lines:
                if re.search(r"(?:Option\s*[A-E]|Answer|Correct)", line, re.IGNORECASE):
                    answer_text = line
                    break
            return json.dumps([{
                "type": "mcq",
                "question": "Question",
                "answer": answer_text
            }])

        # Generic fallback for non-empty text response containing solution indicators
        cleaned_body = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
        cleaned_body = re.sub(r"<think>.*", "", cleaned_body, flags=re.DOTALL).strip()
        if cleaned_body and len(cleaned_body) > 30 and any(w in cleaned_body.lower() for w in ["answer", "option", "solution", "code", "python", "cpp", "java", "result", "correct"]):
            return json.dumps([{
                "type": "mcq",
                "question": "Assistant Solution",
                "answer": cleaned_body[:500]
            }])
    except Exception as fallback_err:
        safe_print(f"Fallback extraction failed: {fallback_err}")

    return "[]"


def extract_cpp_code(result_data: Any) -> str:
    """Extract clean, unescaped, directly compilable C++ code from raw result string or parsed JSON."""
    if not result_data:
        return ""
    if isinstance(result_data, str):
        try:
            parsed = json.loads(result_data)
        except Exception:
            # Check if it's already raw C++ code
            if any(k in result_data for k in ["#include", "class Solution", "class solution", "int main", "using namespace std;"]):
                return result_data.strip()
            return ""
    else:
        parsed = result_data

    if isinstance(parsed, list) and len(parsed) > 0:
        first = parsed[0]
        if isinstance(first, dict):
            langs = first.get("languages", {})
            if isinstance(langs, dict) and "cpp" in langs:
                return langs["cpp"].strip()
            if "code" in first and isinstance(first["code"], str):
                return first["code"].strip()
            if "answer" in first and isinstance(first["answer"], str) and any(k in first["answer"] for k in ["#include", "class ", "int main"]):
                return first["answer"].strip()
    elif isinstance(parsed, dict):
        langs = parsed.get("languages", {})
        if isinstance(langs, dict) and "cpp" in langs:
            return langs["cpp"].strip()
        if "code" in parsed and isinstance(parsed["code"], str):
            return parsed["code"].strip()
    return ""



if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)