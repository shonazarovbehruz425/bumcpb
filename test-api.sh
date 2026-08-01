#!/bin/bash
sleep 3
JID=$(curl -s -X POST http://localhost:8080/generate \
  -H "x-api-key: 68a816138699337a887c64d14b5402f8" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"a purple star"}' | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)

echo "Job ID: $JID"
sleep 90
curl -s "http://localhost:8080/jobs/$JID" | python3 -m json.tool
