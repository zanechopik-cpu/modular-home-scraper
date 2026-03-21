#!/bin/bash
# Modular Home Builder Finder - Setup Script
# Run this on your Mac: bash setup.sh

set -e

PROJECT_DIR="$HOME/modular-home-scraper"

echo "Setting up Modular Home Builder Finder..."

# Create directories
mkdir -p "$PROJECT_DIR/public"
cd "$PROJECT_DIR"

# Create package.json
cat > package.json << 'PKGJSON'
{
  "name": "modular-home-builder-finder",
  "version": "1.0.0",
  "description": "Interactive chatbot that helps users find modular home builders",
  "scripts": {
    "dev": "node server.js",
    "start": "node server.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "express": "^4.21.0"
  }
}
PKGJSON

echo "Created package.json"

# Install dependencies
npm install
echo "Dependencies installed"

echo ""
echo "Setup complete!"
echo "Now you need to create two more files. The script will download them next..."
