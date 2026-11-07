#!/usr/bin/env bash
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
cd ~/Documents/home/station-llm/agent-service
docker compose up -d --build 2>&1 | tail -3
sleep 4
TOKEN=$(grep '^AGENT_ADMIN_TOKEN=' secrets/agent/mcp.env | cut -d= -f2-)
B=http://127.0.0.1:4100
J='-H Content-Type:application/json'
A="Authorization: Bearer $TOKEN"

echo "== health after rebuild =="
curl -s $B/health; echo

echo "== dashed secret name =="
M=$(curl -s -X POST $B/admin/mcp -H "$A" $J -d '{"name":"demo2","transport":"http","url":"http://127.0.0.1:9/x","secret_refs":["X-Api-Key"]}')
MID=$(echo "$M" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
curl -s -X PUT $B/admin/mcp/$MID/secrets -H "$A" $J -d '{"secrets":[{"name":"X-Api-Key","value":"v1"}]}'; echo
curl -s $B/admin/mcp/$MID/secrets -H "$A"; echo
curl -s -X DELETE $B/admin/mcp/$MID -H "$A" > /dev/null; echo "demo2 deleted"

echo "== If-Match semantics =="
V=$(curl -s $B/admin/agents/1 -H "$A" | grep -o '"version":[0-9]*' | cut -d: -f2)
echo "current version: $V"
curl -s -o /dev/null -w "If-Match wrong -> %{http_code}\n" -X PATCH $B/admin/agents/1 -H "$A" -H "If-Match: 999" $J -d '{"max_tokens":250}'
curl -s -o /dev/null -w "If-Match right -> %{http_code}\n" -X PATCH $B/admin/agents/1 -H "$A" -H "If-Match: $V" $J -d '{"max_tokens":250}'

echo "== cleanup: delete test agent 'other' =="
OID=$(curl -s $B/admin/agents -H "$A" | grep -o '"id":[0-9]*,"slug":"other"' | grep -o '"id":[0-9]*' | cut -d: -f2)
[ -n "$OID" ] && curl -s -X DELETE $B/admin/agents/$OID -H "$A"; echo

echo "== full agent chat after rebuild (tool path) =="
SKEY=$(curl -s -X POST $B/admin/stations/1/key -H "$A" | grep -o '"key":"[^"]*"' | cut -d'"' -f4)
curl -s -X POST $B/v1/chat/completions -H "Authorization: Bearer $SKEY" $J -d '{
  "model":"agent:home","stream":false,"temperature":0,"max_tokens":1024,
  "messages":[{"role":"user","content":"Сколько сейчас времени?"}]}' | head -c 700; echo

echo "== final state =="
curl -s $B/admin/agents -H "$A" | grep -o '"slug":"[^"]*"'
curl -s $B/admin/stations -H "$A" | head -c 300; echo
docker ps --filter name=station-llm-agent --format "{{.Names}} {{.Status}}"
