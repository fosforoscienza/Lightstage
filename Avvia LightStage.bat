@echo off
title LightStage
cd /d "%~dp0"

set PY=
where py >nul 2>nul && set PY=py -3
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo Python 3 non trovato. Scaricalo da https://www.python.org/downloads/
  echo e durante l'installazione spunta "Add Python to PATH".
  pause
  exit /b 1
)

%PY% -c "import flask, serial" >nul 2>nul || (
  echo Prima installazione delle dipendenze...
  %PY% -m pip install -r requirements.txt
)

%PY% lightstage.py
pause
