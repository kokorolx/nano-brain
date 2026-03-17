#!/bin/bash
set -e
CONFIG="$HOME/.nano-brain/config.yml"
sed -i '' 's|model: litellm/claude-haiku-4-5|model: gitlab/claude-haiku-4-5|g' "$CONFIG"
echo "Updated. Verify:"
grep "model:" "$CONFIG"
