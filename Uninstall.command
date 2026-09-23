#!/bin/bash
# Double-click to remove idle-compactor.
cd "$(dirname "$0")"
if [ -f ./uninstall.sh ]; then
  bash ./uninstall.sh
else
  curl -fsSL https://raw.githubusercontent.com/intenex/claude-idle-compactor/main/uninstall.sh | bash
fi
status=$?
echo
read -r -p "Press Return to close this window. " _
exit $status
