#!/usr/bin/env bash
# E2E verification on Mac mini. Reads AGENT_ADMIN_TOKEN from mcp.env, never prints it.
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
cd ~/Documents/home/station-llm/agent-service
TOKEN=$(grep '^AGENT_ADMIN_TOKEN=' secrets/agent/mcp.env | cut -d= -f2-)
B=http://127.0.0.1:4100
J='-H Content-Type:application/json'

echo "== 1. health =="
curl -s $B/health; echo

echo "== 2. create agent =="
AGENT=$(curl -s -X POST $B/admin/agents -H "Authorization: Bearer $TOKEN" $J -d '{
  "slug":"home","system_prompt":"Ты домашний помощник Ярослава. Отвечай по делу и доброжелательно.",
  "model":"op-gemini-3.8-flash","fallback_model":"op-deepseek-v4.1-flash","tools_enabled":["*"]}')
echo "$AGENT" | head -c 300; echo
AID=$(echo "$AGENT" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

echo "== 3. create station =="
ST=$(curl -s -X POST $B/admin/stations -H "Authorization: Bearer $TOKEN" $J -d '{"device":"test-mini"}')
echo "$ST"; SID=$(echo "$ST" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

curl -s -X PUT $B/admin/stations/$SID/agent -H "Authorization: Bearer $TOKEN" $J -d "{\"agent_id\":$AID}"; echo

echo "== 4. issue key =="
KEYJSON=$(curl -s -X POST $B/admin/stations/$SID/key -H "Authorization: Bearer $TOKEN")
SKEY=$(echo "$KEYJSON" | grep -o '"key":"[^"]*"' | cut -d'"' -f4)
echo "key issued: ${SKEY:0:18}... (len ${#SKEY})"

echo "== 5. agent chat (which time → builtin tool) =="
curl -s -X POST $B/v1/chat/completions -H "Authorization: Bearer $SKEY" $J -d '{
  "model":"agent:home","stream":false,"temperature":0,"max_tokens":1024,
  "messages":[{"role":"system","content":"bridge default"},{"role":"user","content":"Сколько сейчас времени?"}]
}' > /tmp/agent_chat.json
cat /tmp/agent_chat.json | head -c 900; echo

echo "== 6. plain chat (proxy) =="
curl -s -X POST $B/v1/chat/completions -H "Authorization: Bearer $SKEY" $J -d '{
  "model":"op-gemini-3.8-flash","stream":false,"temperature":0,"max_tokens":64,
  "messages":[{"role":"user","content":"Скажи одно слово: работает"}]
}' | head -c 400; echo

echo "== 7. admin SSE test =="
curl -sN -X POST $B/admin/agents/$AID/test -H "Authorization: Bearer $TOKEN" $J \
  -d '{"prompt":"Который час?","voice":false}' | head -40

echo "== 8. models =="
curl -s $B/v1/models -H "Authorization: Bearer $SKEY" | head -c 300; echo

echo "== 9. audit tail =="
curl -s "$B/admin/audit?limit=12" -H "Authorization: Bearer $TOKEN" | grep -o '"event":"[^"]*"' | sort | uniq -c
