package server

import (
	"encoding/json"
	"time"
)

// registerBase installs the transport-level handlers that exist independent of
// any IO seam: ping (liveness) and echo (round-trips params + binary payload).
// Mirrors registerPhase1Handlers in wasm/server/server.js.
func registerBase(r *Registry) {
	r.Register("ping", func(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
		return Response{Result: map[string]any{"pong": true, "now": time.Now().UnixMilli()}}, nil
	})

	r.Register("echo", func(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
		// Return params verbatim (RawMessage re-marshals byte-identically); echo
		// any binary payload back too.
		var result json.RawMessage
		if len(params) > 0 {
			result = params
		}
		if len(payload) > 0 {
			return Response{Result: result, Payload: payload}, nil
		}
		return Response{Result: result}, nil
	})
}
