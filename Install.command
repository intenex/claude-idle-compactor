#!/bin/bash
# Double-click to install idle-compactor for Claude Code (terminal and the
# Claude desktop app's Code tab). Runs install.sh from this folder, or the
# latest one from GitHub when opened on its own.
cd "$(dirname "$0")"
if [ -f ./install.sh ]; then
  bash ./install.sh
else
  curl -fsSL https://raw.githubusercontent.com/intenex/claude-idle-compactor/main/install.sh | bash
fi
status=$?
echo
read -r -p "Press Return to close this window. " _
exit $status
