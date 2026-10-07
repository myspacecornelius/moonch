#!/usr/bin/env bash
# Create a virtual environment and install pinned dependencies.
# Does not install system packages or pipe remote scripts into a shell.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required. Install it with your package manager or from" >&2
  echo "https://www.python.org/downloads/ and re-run this script." >&2
  exit 1
fi

echo "Creating virtual environment in ./venv ..."
python3 -m venv venv

echo "Installing pinned dependencies ..."
venv/bin/pip install -r requirements.txt

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example - add your APOLLO_API_KEY there."
fi

echo "Setup complete."
echo "  source venv/bin/activate"
echo "  python src/example.py"
echo "Selenium needs Chrome or Chromium; see README for CHROME_BIN / CHROMEDRIVER_PATH."
