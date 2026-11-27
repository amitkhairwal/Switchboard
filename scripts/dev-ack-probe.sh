#!/bin/sh
# Dev helper (run inside the dev container): start the server on :4000, run the
# chaos profile against it, print Pigeon's view of our acknowledgement latency.
cd /work
(npm --prefix scaffold/server start > /tmp/srv.log 2>&1 &)
sleep 6
curl -s localhost:4000/healthz; echo
curl -s -XPOST localhost:4000/__grader/reset -H 'x-grader-token: grader-dev-token' >/dev/null
curl -s -XPOST localhost:4010/__admin/reset >/dev/null
curl -s -XPOST localhost:4010/__admin/start -H 'content-type: application/json' -d '{"profile":"chaos","seconds":20}' >/dev/null
sleep 34
node -e "fetch('http://localhost:4010/__admin/report').then(r=>r.json()).then(r=>console.log(JSON.stringify(r.webhooks)))"
tail -5 /tmp/srv.log
pkill -f 'tsx src/index.ts'; pkill -f 'src/index.ts'; true
