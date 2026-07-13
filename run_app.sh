#!/bin/bash

# Exit on error
set -e

# specific to Linux desktop environments, might not work on headless servers
open_browser() {
    if which xdg-open > /dev/null; then
        xdg-open "http://localhost:5000"
    elif which gnome-open > /dev/null; then
        gnome-open "http://localhost:5000"
    else
        echo "Could not detect web browser to open. Please visit http://localhost:5000 manually."
    fi
}

if [ ! -d "venv" ]; then
    echo "Virtual environment not found. Please run install_dependencies.sh first."
    exit 1
fi

source venv/bin/activate

echo "Starting Redaction Guesser..."
# Ensure requirements are up to date
pip install -r requirements.txt

# Launch browser in background (give the app a moment to start)
(sleep 2 && open_browser) &

python3 manage.py runserver 5000
