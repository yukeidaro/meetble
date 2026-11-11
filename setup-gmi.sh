#!/usr/bin/env bash
# One-shot setup of the Meetble server on a fresh Ubuntu VM (GMI Cloud or any cloud).
#   curl -fsSL https://raw.githubusercontent.com/yukeidaro/meetble/main/setup-gmi.sh | bash
# Then put your keys in ~/meetble/.env and run ~/meetble/start-gmi.sh
set -e
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
  $SUDO apt-get install -y nodejs
fi
command -v python3 >/dev/null || $SUDO apt-get install -y python3
command -v git >/dev/null || $SUDO apt-get install -y git
cd "$HOME"
if [ ! -d meetble ]; then git clone https://github.com/yukeidaro/meetble.git; fi
cd meetble
git pull --ff-only
npm ci --no-audit --no-fund
npm run build
if [ ! -f .env ]; then cp .env.example .env; fi
if [ ! -f .meetble_token ]; then od -An -N12 -tx1 /dev/urandom | tr -d ' \n' > .meetble_token; fi
chmod +x start-gmi.sh
echo
echo "Done. Next:"
echo "  1) nano ~/meetble/.env   (paste your API keys; save with Ctrl+O, Enter, Ctrl+X)"
echo "  2) optional: put your user_profile.json in ~/meetble/"
echo "  3) ~/meetble/start-gmi.sh   (keep it running; it prints the URL to open)"
echo "  If the page doesn't load, open TCP port 8787 in the GMI firewall / security group."
