package proxy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"testing"
)

func TestEncodeDecodeRoundTrip(t *testing.T) {
	payload := []byte{0, 1, 2, 255, 254, 0, 42}
	h := Header{T: TReq, ID: 7, Method: "fs.read", Params: json.RawMessage(`{"len":16}`)}
	frame, err := Encode(h, payload)
	if err != nil {
		t.Fatal(err)
	}
	got, gotPayload, err := Decode(frame)
	if err != nil {
		t.Fatal(err)
	}
	if got.T != h.T || got.ID != h.ID || got.Method != h.Method {
		t.Fatalf("header mismatch: %+v vs %+v", got, h)
	}
	if string(got.Params) != string(h.Params) {
		t.Fatalf("params mismatch: %s vs %s", got.Params, h.Params)
	}
	if !bytes.Equal(gotPayload, payload) {
		t.Fatalf("payload mismatch: %v vs %v", gotPayload, payload)
	}
}

func TestDecodeHeaderOnly(t *testing.T) {
	frame := MustEncode(Header{T: TPush, Method: "proc.exit", Params: json.RawMessage(`{"id":1,"code":0}`)}, nil)
	h, payload, err := Decode(frame)
	if err != nil {
		t.Fatal(err)
	}
	if h.T != TPush || h.Method != "proc.exit" {
		t.Fatalf("bad header: %+v", h)
	}
	if len(payload) != 0 {
		t.Fatalf("expected empty payload, got %d bytes", len(payload))
	}
}

func TestDecodeShortFrame(t *testing.T) {
	if _, _, err := Decode([]byte{1, 2}); err == nil {
		t.Fatal("expected error on short frame")
	}
	// headerLen claims more than the buffer holds.
	bad := []byte{255, 0, 0, 0, '{', '}'}
	if _, _, err := Decode(bad); err == nil {
		t.Fatal("expected error on oversized headerLen")
	}
}

func TestDecodeInvalidJSONHeader(t *testing.T) {
	// headerLen=5 but the 5 header bytes are not valid JSON.
	data := []byte{5, 0, 0, 0, '{', 'n', 'o', 't', ' '}
	if _, _, err := Decode(data); err == nil {
		t.Fatal("expected error decoding an invalid-JSON header")
	}
}

func TestDecodeOversizedHeaderLen(t *testing.T) {
	// headerLen claims ~4GiB; must error, not panic or over-read.
	data := []byte{0xFF, 0xFF, 0xFF, 0xFF, '{', '}'}
	if _, _, err := Decode(data); err == nil {
		t.Fatal("expected error on oversized headerLen")
	}
}

func TestEncodeDecodeLargePayload(t *testing.T) {
	// A multi-MiB payload (PTY burst / large file read) must round-trip exactly.
	payload := make([]byte, 2<<20)
	for i := range payload {
		payload[i] = byte(i*131 + 7)
	}
	frame := MustEncode(Header{T: TRes, ID: 1}, payload)
	h, got, err := Decode(frame)
	if err != nil {
		t.Fatal(err)
	}
	if h.ID != 1 {
		t.Fatalf("header id = %d", h.ID)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("large payload mismatch (%d vs %d bytes)", len(got), len(payload))
	}
}

func TestStreamFrameRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	frames := []struct {
		h Header
		p []byte
	}{
		{Header{T: THello, ID: 1, Version: ProtocolVersion}, nil},
		{Header{T: TReq, ID: 2, Method: "echo", Params: json.RawMessage(`{"x":1}`)}, []byte("payload-bytes")},
		{Header{T: TCancel, ID: 2}, nil},
	}
	for _, f := range frames {
		if err := WriteStreamFrame(&buf, f.h, f.p); err != nil {
			t.Fatal(err)
		}
	}
	r := bufio.NewReader(&buf)
	for i, want := range frames {
		h, p, err := ReadStreamFrame(r)
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if h.T != want.h.T || h.ID != want.h.ID {
			t.Fatalf("frame %d header mismatch: %+v vs %+v", i, h, want.h)
		}
		if !bytes.Equal(p, want.p) {
			t.Fatalf("frame %d payload mismatch: %q vs %q", i, p, want.p)
		}
	}
}
