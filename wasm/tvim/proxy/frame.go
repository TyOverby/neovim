// Package proxy implements the stage-4/5 IO-proxy wire protocol in Go: the frame
// codec shared by every transport (WebSocket, SSH stdio, in-process), and — in
// later phases — the io-proxy handlers themselves. This file is the codec only.
//
// THE WIRE FRAME (identical to wasm/proxy-client.js, byte-for-byte):
//
//		uint32LE headerLen | headerJSON (utf8) | payloadBytes?
//
//	  - headerLen    little-endian uint32: byte length of the header JSON.
//	  - headerJSON   a UTF-8 JSON control object (see Header).
//	  - payloadBytes OPTIONAL raw binary trailer (file bytes, stdio, pty output).
//
// Over a MESSAGE transport (WebSocket) the message boundary delimits the frame,
// so the payload is "everything after the header" — Encode/Decode handle that.
// Over a STREAM transport (SSH stdio / pipe) there are no message boundaries, so
// WriteStreamFrame/ReadStreamFrame wrap each frame in an outer u32 total-length
// prefix; the inner bytes are the exact same Encode output (added in the
// SSH-stdio phase; defined here so both halves live together).
package proxy

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

// ProtocolVersion is advertised in the hello handshake; mismatched peers warn
// loudly (separately-built client/app/remote binaries can drift). Bump on any
// breaking wire change.
const ProtocolVersion = 1

// Frame kinds (the Header.T tag).
const (
	TReq    = "req"    // client->server request           {t,id,method,params}
	TRes    = "res"    // server->client response          {t,id,ok,result,error}
	TPush   = "push"   // server->client unsolicited       {t,method,params}  (no id)
	THello  = "hello"  // client->server handshake         {t,id,params,version}
	TCancel = "cancel" // client->server abort in-flight   {t,id}   (stage 5)
)

// Header is the JSON control object at the head of every frame. Params and
// Result are arbitrary JSON carried opaque (RawMessage) so the codec never has
// to know a method's shape; handlers unmarshal them into concrete types.
type Header struct {
	T       string          `json:"t"`
	ID      int             `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	OK      *bool           `json:"ok,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
	Version int             `json:"version,omitempty"`
}

// Encode lays out one frame: u32LE(len(headerJSON)) | headerJSON | payload.
// A nil/empty payload yields a header-only frame. Mirrors proxy-client.js
// encodeFrame exactly.
func Encode(h Header, payload []byte) ([]byte, error) {
	hb, err := json.Marshal(h)
	if err != nil {
		return nil, fmt.Errorf("proxy: marshal header: %w", err)
	}
	out := make([]byte, 4+len(hb)+len(payload))
	binary.LittleEndian.PutUint32(out[0:4], uint32(len(hb)))
	copy(out[4:], hb)
	if len(payload) > 0 {
		copy(out[4+len(hb):], payload)
	}
	return out, nil
}

// MustEncode is Encode for headers known to marshal (no user-supplied funcs).
func MustEncode(h Header, payload []byte) []byte {
	b, err := Encode(h, payload)
	if err != nil {
		panic(err)
	}
	return b
}

// Decode parses one whole-message frame back into its header and payload. The
// payload is a fresh copy (the caller may reuse the inbound buffer). Mirrors
// proxy-client.js decodeFrame.
func Decode(data []byte) (Header, []byte, error) {
	if len(data) < 4 {
		return Header{}, nil, fmt.Errorf("proxy: frame too short (%d bytes)", len(data))
	}
	headerLen := binary.LittleEndian.Uint32(data[0:4])
	if 4+int(headerLen) > len(data) {
		return Header{}, nil, fmt.Errorf("proxy: header length %d exceeds frame (%d)", headerLen, len(data))
	}
	var h Header
	if err := json.Unmarshal(data[4:4+headerLen], &h); err != nil {
		return Header{}, nil, fmt.Errorf("proxy: unmarshal header: %w", err)
	}
	var payload []byte
	if rest := data[4+headerLen:]; len(rest) > 0 {
		payload = make([]byte, len(rest))
		copy(payload, rest)
	}
	return h, payload, nil
}

// WriteStreamFrame writes a frame to a byte stream (SSH stdio / pipe), wrapping
// Encode's output in an outer u32LE total-length prefix so the reader can re-cut
// frame boundaries a stream does not provide.
func WriteStreamFrame(w io.Writer, h Header, payload []byte) error {
	inner, err := Encode(h, payload)
	if err != nil {
		return err
	}
	var lp [4]byte
	binary.LittleEndian.PutUint32(lp[:], uint32(len(inner)))
	if _, err := w.Write(lp[:]); err != nil {
		return err
	}
	_, err = w.Write(inner)
	return err
}

// ReadStreamFrame reads one length-prefixed frame from a stream. Returns
// io.EOF (wrapped) when the stream closes cleanly between frames — the remote
// hangup signal the reconnect contract keys on.
func ReadStreamFrame(r *bufio.Reader) (Header, []byte, error) {
	var lp [4]byte
	if _, err := io.ReadFull(r, lp[:]); err != nil {
		return Header{}, nil, err
	}
	total := binary.LittleEndian.Uint32(lp[:])
	inner := make([]byte, total)
	if _, err := io.ReadFull(r, inner); err != nil {
		return Header{}, nil, err
	}
	return Decode(inner)
}

// Helpers for building common response frames (used by the server in later
// phases; handy in tests now).

// ResOK builds an ok response carrying result + optional payload.
func ResOK(id int, result json.RawMessage, payload []byte) ([]byte, error) {
	ok := true
	return Encode(Header{T: TRes, ID: id, OK: &ok, Result: result}, payload)
}

// ResErr builds an error response.
func ResErr(id int, msg string) []byte {
	ok := false
	return MustEncode(Header{T: TRes, ID: id, OK: &ok, Error: msg}, nil)
}
