@echo off
:: ============================================================
:: Build Sonar Edge Controller into a standalone .exe
:: Requires: pip install pyinstaller
:: ============================================================

cd /d "%~dp0"

pyinstaller ^
  --name "SonarEdge" ^
  --onedir ^
  --noconsole ^
  --add-data "index.html;." ^
  --add-data "app.js;." ^
  --add-data "style.css;." ^
  --hidden-import comtypes.stream ^
  --hidden-import comtypes._comobject ^
  --hidden-import pycaw.pycaw ^
  --hidden-import clr ^
  main.py

echo.
echo Build complete. Output: dist\SonarEdge\SonarEdge.exe
pause
