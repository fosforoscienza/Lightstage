#!/bin/bash
# Avvio di LightStage su Linux: ./avvia-lightstage.sh
# (o doppio clic se il file manager lo consente)
cd "$(dirname "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 non trovato: installalo con  sudo apt install python3 python3-pip"
  read -r -p "Premi Invio per chiudere..."
  exit 1
fi

if ! python3 -c "import flask, serial" >/dev/null 2>&1; then
  echo "Prima installazione delle dipendenze..."
  python3 -m pip install -r requirements.txt 2>/dev/null \
    || python3 -m pip install --user -r requirements.txt 2>/dev/null \
    || python3 -m pip install --user --break-system-packages -r requirements.txt
fi

python3 lightstage.py
