@echo off
cd /d "%~dp0"
python -m pip install -r requirements.txt pyinstaller
python -m PyInstaller --noconsole --onefile --name PianoTrigger --add-data "web;web" app.py
echo.
echo Done: dist\PianoTrigger.exe
pause
