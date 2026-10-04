@echo off
title Browser Assistant Backend Server
echo ===================================================
echo     Starting Browser Assistant Backend Server
echo ===================================================

:: Ensure local Ollama is running in background if available
where ollama >nul 2>&1
if %ERRORLEVEL% equ 0 (
    curl.exe -s http://127.0.0.1:11434/api/tags >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        echo Starting local Ollama service in background...
        start /b "" ollama serve >nul 2>&1
        timeout /t 2 /nobreak >nul
    )
)

cd /d "%~dp0server"
if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" main.py
) else (
    python main.py
)
pause

