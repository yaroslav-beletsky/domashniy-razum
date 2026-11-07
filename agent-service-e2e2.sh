#!/usr/bin/env bash
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
cd ~/Documents/home/station-llm/agent-service
TOKEN=$(grep '^AGENT_ADMIN_TOKEN=' secrets/agent/mcp.env | cut -d= -f2-)
B=http://127.0.0.1:4100
J='-H Content-Type:application/json'
A="Authorization: Bearer $TOKEN"

echo "== mcp server CRUD =="
M=$(curl -s -X POST $B/admin/mcp -H "$A" $J -d '{"name":"demo","transport":"http","url":"http://127.0.0.1:9/mcp","timeout_ms":1500}')
echo "$M"; MID=$(echo "$M" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
curl -s -X PUT $B/admin/mcp/$MID/secrets -H "$A" $J -d '{"secrets":[{"name":"X-Api-Key","value":"secret-value-1"}]}'; echo
curl -s $B/admin/mcp/$MID/secrets -H "$A"; echo
echo "-- refresh (expect error, circuit starts) --"
curl -s -X POST $B/admin/mcp/$MID/refresh -H "$A"; echo
echo "-- patch disable --"
curl -s -X PATCH $B/admin/mcp/$MID -H "$A" $J -d '{"enabled":false}'; echo
curl -s -X DELETE $B/admin/mcp/$MID -H "$A"; echo

echo "== agent PATCH with If-Match =="
curl -s -X PATCH $B/admin/agents/1 -H "$A" $J -d '{"version":1,"max_tokens":250}'; echo
echo "-- wrong version --"
curl -s -o /dev/null -w "%{http_code}\n" -X PATCH $B/admin/agents/1 -H "$A" $J -d '{"version":1}'

echo "== forbidden agent for station =="
KEY=$(grep '^AGENT_ADMIN_TOKEN=' secrets/agent/mcp.env | cut -d= -f2-)
SKEY=$(curl -s -X POST $B/admin/stations/1/key -H "$A" | grep -o '"key":"[^"]*"' | cut -d'"' -f4)
curl -s -X POST $B/admin/agents -H "$A" $J -d '{"slug":"other","model":"op-gemini-3.8-flash"}' > /dev/null
curl -s -o /dev/null -w "agent:other with station key -> %{http_code}\n" -X POST $B/v1/chat/completions \
  -H "Authorization: Bearer $SKEY" $J -d '{"model":"agent:other","messages":[{"role":"user","content":"hi"}]}'
curl -s -o /dev/null -w "no key -> %{http_code}\n" -X POST $B/v1/chat/completions $J \
  -d '{"model":"agent:home","messages":[{"role":"user","content":"hi"}]}'

echo "== LAN binding =="
curl -s -o /dev/null -w "192.168.88.207:4100/health -> %{http_code}\n" http://192.168.88.207:4100/health

echo "== audit tail =="
curl -s "$B/admin/audit?limit=30" -H "$A" | grep -o '"event":"[^"]*"' | sort | uniq -c || true

echo "== overhead measurement (5 fast-path runs, tools off) =="
V=$(curl -s $B/admin/agents/1 -H "$A" | grep -o '"version":[0-9]*' | cut -d: -f2)
curl -s -X PATCH $B/admin/agents/1 -H "$A" $J -d "{\"version\":$V,\"tools_enabled\":[]}" > /dev/null
for i in 1 2 3 4 5; do
  curl -s -X POST $B/v1/chat/completions -H "Authorization: Bearer $SKEY" $J -d '{
    "model":"agent:home","stream":false,"max_tokens":16,
    "messages":[{"role":"user","content":"привет"}]}' > /tmp/r.json
  grep -o '"overhead_ms":[0-9]*' /tmp/r.json
done
V=$(curl -s $B/admin/agents/1 -H "$A" | grep -o '"version":[0-9]*' | cut -d: -f2)
curl -s -X PATCH $B/admin/agents/1 -H "$A" $J -d "{\"version\":$V,\"tools_enabled\":[\"*\"]}" > /dev/null
echo "tools restored"
