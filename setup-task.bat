@echo off
:: ============================================================
:: Sonar Edge Controller — Task Scheduler Setup
:: Run this ONCE (as administrator) to register auto-launch
:: ============================================================

echo.
echo  Sonar Edge Controller - Auto-Start Setup
echo  =========================================
echo.

:: Get the directory this script lives in
set "SCRIPT_DIR=%~dp0"

:: Register the scheduled task
schtasks /create /tn "SonarEdgeController" ^
  /tr "\"%SCRIPT_DIR%launch.bat\"" ^
  /sc onlogon ^
  /delay 0000:30 ^
  /rl limited ^
  /f

if %errorlevel% equ 0 (
  echo.
  echo  [OK] Task "SonarEdgeController" registered successfully.
  echo  It will run launch.bat 30 seconds after you log in.
) else (
  echo.
  echo  [ERROR] Failed to create task. Try running as Administrator.
)

echo.
echo  =========================================
echo  SETUP COMPLETE - Next steps:
echo  =========================================
echo.
echo  1. Test manually first:
echo     - Run launch.bat
echo     - Open http://localhost:5199 in your browser
echo     - Confirm UI loads and sliders respond
echo.
echo  2. Set up iCUE iFrame widget:
echo     - Open iCUE
echo     - Open Xeneon Edge widget editor
echo     - Add new widget: iFrame
echo     - URL: http://localhost:5199
echo     - Stretch to fill full Edge display
echo     - Save
echo.
echo  3. Test in iCUE:
echo     - Confirm the UI renders on the Edge screen
echo     - Test touch controls on the Edge display
echo.
echo  4. Reboot and verify:
echo     - The server should auto-start after login
echo     - The Edge widget should connect automatically
echo.
pause
