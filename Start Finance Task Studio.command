#!/bin/zsh
# User-invoked launcher. Starts only the local viewer; never starts a model run.
set -e
cd -- "${0:A:h}"
for studio_node in /opt/homebrew/bin/node /usr/local/bin/node '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node'; do
  if [[ -x "$studio_node" ]]; then
    exec "$studio_node" backend/server.cjs --open
  fi
done
printf '%s\n' 'No local Node runtime was found. Open Finance_Task_Studio.html directly; offline analysis requires no installation.'
read -r 'reply?Press Return to close.'
