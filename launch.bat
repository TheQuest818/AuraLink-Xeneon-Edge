@echo off
:: ============================================================
:: Sonar Edge Controller — Launch Script
:: Waits 30s for SteelSeries GG to start, then runs server.py
:: ============================================================

:: 30 second delay to let SteelSeries GG initialize
timeout /t 30 /nobreak >nul

:: Change to script directory (wherever this .bat lives)
cd /d "%~dp0"

:: Start the server minimized and in background
start /min "" python main.py
