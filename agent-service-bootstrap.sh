#!/usr/bin/env bash
# One-time bootstrap on Mac mini: secrets for agent-service. Never prints secrets.
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
DEST=~/Documents/home/station-llm/agent-service
cd "$DEST"

mkdir -p secrets/agent
chmod 700 secrets secrets/agent

if [ ! -f secrets/agent/mcp.env ]; then
  KEY=$(grep -E '^LITELLM_(API_KEY|MASTER_KEY)=' ~/Documents/home/station-llm/panel/.env | head -1 | cut -d= -f2-)
  KEY=${KEY#\"}; KEY=${KEY%\"}; KEY=${KEY#\'}; KEY=${KEY%\'}
  ADMIN=$(openssl rand -hex 24)
  umask 177
  {
    printf 'LITELLM_API_KEY=%s\n' "$KEY"
    printf 'AGENT_ADMIN_TOKEN=%s\n' "$ADMIN"
  } > secrets/agent/mcp.env
  chmod 600 secrets/agent/mcp.env
  echo "mcp.env created (0600)"
else
  echo "mcp.env exists, left as-is"
fi

docker compose up -d --build
