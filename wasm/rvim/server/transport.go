package server

import (
	"bufio"
	"context"
	"encoding/binary"
	"io"
	"os"
	"os/exec"

	"github.com/coder/websocket"
)

// frameRW is a transport that carries raw proxy-frame bytes (the output of
// proxy.Encode, WITHOUT the codec's own knowledge of framing): a WebSocket
// delimits frames by message; a byte stream (SSH stdio / pipe) delimits them
// with a u32LE length prefix. The conn layer does Encode/Decode on top.
type frameRW interface {
	readRaw() ([]byte, error)  // one frame's bytes (no outer framing)
	writeRaw(raw []byte) error // write one frame's bytes (adds outer framing)
	close()                    // clean shutdown
	closeNow()                 // abrupt shutdown (reconnect-test drop)
}

// ---- WebSocket transport ----------------------------------------------------

type wsFrameRW struct{ ws *websocket.Conn }

func (t *wsFrameRW) readRaw() ([]byte, error) {
	_, data, err := t.ws.Read(context.Background())
	return data, err
}

func (t *wsFrameRW) writeRaw(raw []byte) error {
	return t.ws.Write(context.Background(), websocket.MessageBinary, raw)
}

func (t *wsFrameRW) close()    { _ = t.ws.Close(websocket.StatusNormalClosure, "") }
func (t *wsFrameRW) closeNow() { _ = t.ws.CloseNow() }

// ---- stdio (byte-stream) transport ------------------------------------------
// Frames are length-prefixed: u32LE total-length | proxy.Encode bytes. This is
// the SSH-stdio / pipe framing (mirrors proxy.{Read,Write}StreamFrame, but at the
// raw-bytes level so the relay can transcode without decoding).

type stdioFrameRW struct {
	r *bufio.Reader
	w io.Writer
}

func (t *stdioFrameRW) readRaw() ([]byte, error) {
	var lp [4]byte
	if _, err := io.ReadFull(t.r, lp[:]); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(lp[:])
	buf := make([]byte, n)
	if _, err := io.ReadFull(t.r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func (t *stdioFrameRW) writeRaw(raw []byte) error {
	var lp [4]byte
	binary.LittleEndian.PutUint32(lp[:], uint32(len(raw)))
	if _, err := t.w.Write(lp[:]); err != nil {
		return err
	}
	_, err := t.w.Write(raw)
	return err
}

func (t *stdioFrameRW) close()    {}
func (t *stdioFrameRW) closeNow() {}

// ---- the SSH-stdio relay (--remote) -----------------------------------------

// remoteArgv builds the per-connection relay argv: the base RemoteCommand plus
// this browser tab's durable-PTY session id (so the remote io-proxy attaches to
// the remote session-host daemon). It copies rather than mutating the shared base
// slice, and omits --session when empty (non-durable PTYs / no session sent).
func remoteArgv(base []string, session string) []string {
	argv := append([]string(nil), base...)
	if session != "" {
		argv = append(argv, "--session", session)
	}
	return argv
}

// pumpFrames copies whole frames src -> dst until either side errors. Each
// direction has a dedicated writer, so no per-transport write lock is needed.
func pumpFrames(src, dst frameRW) {
	for {
		raw, err := src.readRaw()
		if err != nil {
			return
		}
		if err := dst.writeRaw(raw); err != nil {
			return
		}
	}
}

// relayToRemote forwards a browser WebSocket to a fresh remote io-proxy
// subprocess (RemoteCommand, e.g. `ssh -T host rvim --serve-stdio --root …`) over
// its stdin/stdout. No IO is handled locally — the remote does it all, jailed to
// its own --root. The subprocess is per-connection, so its per-connection state
// (fds, child procs, sockets) is isolated and torn down when the browser
// disconnects (stdin EOF -> remote exits -> remote cleanup). A remote death (ssh
// drop) closes the WebSocket, and the client's ReconnectingProxy dials again —
// spawning a fresh remote.
func (s *Server) relayToRemote(ws *websocket.Conn, session string) {
	argv := remoteArgv(s.cfg.RemoteCommand, session)
	cmd := exec.Command(argv[0], argv[1:]...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		_ = ws.Close(websocket.StatusInternalError, "remote stdin")
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = ws.Close(websocket.StatusInternalError, "remote stdout")
		return
	}
	cmd.Stderr = os.Stderr // surface ssh / remote-rvim logs locally
	if err := cmd.Start(); err != nil {
		_ = ws.Close(websocket.StatusInternalError, "remote start failed")
		return
	}

	wsRW := &wsFrameRW{ws: ws}
	remoteRW := &stdioFrameRW{r: bufio.NewReaderSize(stdout, 64*1024), w: stdin}

	done := make(chan struct{}, 2)
	go func() { pumpFrames(wsRW, remoteRW); done <- struct{}{} }() // browser -> remote
	go func() { pumpFrames(remoteRW, wsRW); done <- struct{}{} }() // remote -> browser
	<-done                                                         // either side closed

	_ = ws.CloseNow()
	_ = stdin.Close()
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
}
