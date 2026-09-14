#!/usr/bin/env bash
# Drive a running instance's ComfyUI over HTTP, with no browser.
#
# Every call below was verified against a live instance created by this tool.
# Get ENDPOINT from `vast-deploy endpoint <id>` or the MCP get_endpoint_usage tool.
set -euo pipefail

ENDPOINT="${1:?usage: drive-comfyui.sh http://IP:PORT [workflow_api.json]}"
WORKFLOW="${2:-}"

echo "== is it up =="
curl -fsS -o /dev/null -w "  HTTP %{http_code}\n" "$ENDPOINT/"

echo "== what is it running on =="
curl -fsS "$ENDPOINT/system_stats" |
  python3 -c "import json,sys; d=json.load(sys.stdin); print('  ComfyUI', d['system'].get('comfyui_version')); [print('  GPU:', x.get('name'), round(x.get('vram_total',0)/1e9,1),'GB') for x in d.get('devices',[])]"

echo "== queue =="
curl -fsS "$ENDPOINT/queue" |
  python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"  running={len(d['queue_running'])} pending={len(d['queue_pending'])}\")"

# The teardown watchdog polls exactly that endpoint: an empty queue for idle_minutes
# is what triggers automatic destruction, so a long think at the UI is not "idle"
# but a finished render is.

if [ -z "$WORKFLOW" ]; then
  echo
  echo "Pass a workflow API JSON to queue it. Export one from ComfyUI with"
  echo "Workflow > Export (API). Build the MiniMax H3 graph described in docs/MINIMAX-H3.md."
  exit 0
fi

echo "== queueing $WORKFLOW =="
PROMPT_ID=$(python3 -c "
import json,sys,urllib.request
wf=json.load(open('$WORKFLOW'))
body=json.dumps({'prompt':wf}).encode()
req=urllib.request.Request('$ENDPOINT/prompt', data=body, headers={'Content-Type':'application/json'})
print(json.load(urllib.request.urlopen(req))['prompt_id'])
")
echo "  prompt_id=$PROMPT_ID"

echo "== waiting =="
while true; do
  done_yet=$(curl -fsS "$ENDPOINT/history/$PROMPT_ID" | python3 -c "import json,sys; print('yes' if json.load(sys.stdin) else 'no')")
  [ "$done_yet" = "yes" ] && break
  printf '.'
  sleep 10
done
echo

echo "== outputs =="
curl -fsS "$ENDPOINT/history/$PROMPT_ID" | python3 -c "
import json,sys
h=json.load(sys.stdin)
for run in h.values():
    for node in run.get('outputs',{}).values():
        for kind in ('images','gifs','videos','audio'):
            for f in node.get(kind,[]):
                print(f\"  {f['filename']}  ->  $ENDPOINT/view?filename={f['filename']}&subfolder={f.get('subfolder','')}&type={f.get('type','output')}\")
"

echo
echo "Download the files above, THEN destroy the instance: vast-deploy destroy <id>"
echo "Destroying deletes the disk. Nothing survives it."
