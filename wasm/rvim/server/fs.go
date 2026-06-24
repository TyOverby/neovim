package server

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
)

// FILESYSTEM PROXY (stage 5 — seam 1). The Go port of wasm/server/fs-handlers.js,
// verified against the same conformance scenarios. Every `path` is MOUNT-RELATIVE
// (a leading-slash, server-relative path); resolveJailed maps it under the jail
// root and guarantees it cannot escape — rejecting `..` traversal AND symlink
// escapes by realpath'ing the nearest existing ancestor and requiring it to stay
// under the realpath'd root.

// open(2) flag bits (musl/Linux values, as nvim's wasm passes them).
const (
	oACCMODE = 0x3
	xRDONLY  = 0x0
	xWRONLY  = 0x1
	xRDWR    = 0x2
	xCREAT   = 0x40
	xEXCL    = 0x80
	xTRUNC   = 0x200
	xAPPEND  = 0x400
)

// jailError carries an EACCES so a failed jail check is reported as a permission
// error (the message is what crosses the wire; the wasm side maps the rejection
// to an errno).
type jailError struct{ msg string }

func (e *jailError) Error() string { return e.msg }

func jailErr(msg string) error { return &jailError{msg: msg} }

// realpathExistingPrefix resolves symlinks on the nearest EXISTING ancestor of p
// and re-appends the non-existent tail (so `:w newfile` works before the leaf
// exists). Mirrors fs-handlers.js realpathExistingPrefix.
func realpathExistingPrefix(p string) string {
	cur := p
	var tail []string
	for i := 0; i < 4096; i++ {
		if real, err := filepath.EvalSymlinks(cur); err == nil {
			if len(tail) == 0 {
				return real
			}
			parts := append([]string{real}, reversed(tail)...)
			return filepath.Join(parts...)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return p // reached the root with nothing resolvable
		}
		tail = append(tail, filepath.Base(cur))
		cur = parent
	}
	return p
}

func reversed(s []string) []string {
	out := make([]string, len(s))
	for i, v := range s {
		out[len(s)-1-i] = v
	}
	return out
}

// resolveJailed maps a mount-relative `rel` to a real server path under root and
// verifies containment. Mirrors fs-handlers.js resolveJailed.
func resolveJailed(root, rel string) (string, error) {
	if root == "" {
		return "", jailErr("fs proxy: no jail root configured")
	}
	if rel == "" {
		rel = "/"
	}
	// Strip leading slashes so an absolute rel cannot replace root; Join cleans
	// any `..`, and the containment check below catches an escape.
	relClean := strings.TrimLeft(rel, "/\\")
	candidate := filepath.Join(root, relClean)

	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		if abs, aerr := filepath.Abs(root); aerr == nil {
			realRoot = abs
		} else {
			realRoot = root
		}
	}
	realCandidate := realpathExistingPrefix(candidate)

	withSep := realRoot
	if !strings.HasSuffix(withSep, string(os.PathSeparator)) {
		withSep += string(os.PathSeparator)
	}
	if realCandidate != realRoot && !strings.HasPrefix(realCandidate, withSep) {
		return "", jailErr(fmt.Sprintf("fs proxy: path '%s' escapes the jail root", rel))
	}
	return realCandidate, nil
}

// ---- per-connection handle table -------------------------------------------

type fsHandle struct {
	path  string
	f     *os.File // nil for directories
	isDir bool
}

type fsTable struct {
	mu   sync.Mutex
	next int
	byID map[int]*fsHandle
}

func fsTableOf(c *Ctx) *fsTable {
	return c.State("fs", func() any {
		return &fsTable{next: 1, byID: map[int]*fsHandle{}}
	}).(*fsTable)
}

func (t *fsTable) add(h *fsHandle) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	id := t.next
	t.next++
	t.byID[id] = h
	return id
}

func (t *fsTable) get(id int) *fsHandle {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.byID[id]
}

func (t *fsTable) remove(id int) *fsHandle {
	t.mu.Lock()
	defer t.mu.Unlock()
	h := t.byID[id]
	delete(t.byID, id)
	return h
}

// statShape maps an os.FileInfo into the {exists,isDir,isLink,size,mode,mtime}
// shape the wasm side fills a struct stat from. mode is the FULL st_mode (type
// bits + perms) so S_IFREG / S_IFDIR survive.
func statShape(fi os.FileInfo, isLstat bool) map[string]any {
	m := map[string]any{
		"exists": true,
		"isDir":  fi.IsDir(),
		"size":   fi.Size(),
		"mtime":  fi.ModTime().UnixMilli(),
		"isLink": isLstat && fi.Mode()&os.ModeSymlink != 0,
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		m["mode"] = uint32(st.Mode)
	} else {
		m["mode"] = uint32(fi.Mode().Perm())
	}
	return m
}

// param decoding helpers.
type fsParams struct {
	Path   string `json:"path"`
	From   string `json:"from"`
	To     string `json:"to"`
	Flags  int    `json:"flags"`
	Mode   *int   `json:"mode"`
	Handle *int   `json:"handle"`
	Pos    int    `json:"pos"`
	Len    int    `json:"len"`
	Dir    bool   `json:"dir"`
}

func decodeFS(params json.RawMessage) (fsParams, error) {
	var p fsParams
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return p, err
		}
	}
	return p, nil
}

// RegisterFS installs the filesystem proxy handlers onto reg.
func RegisterFS(reg *Registry) {
	reg.Register("fs.open", fsOpen)
	reg.Register("fs.read", fsRead)
	reg.Register("fs.write", fsWrite)
	reg.Register("fs.close", fsClose)
	reg.Register("fs.stat", fsStat)
	reg.Register("fs.lstat", fsLstat)
	reg.Register("fs.readdir", fsReaddir)
	reg.Register("fs.mkdir", fsMkdir)
	reg.Register("fs.unlink", fsUnlink)
	reg.Register("fs.rename", fsRename)
}

func fsOpen(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	p, err := decodeFS(params)
	if err != nil {
		return Response{}, err
	}
	path, err := resolveJailed(c.Config.Root, p.Path)
	if err != nil {
		return Response{}, err
	}
	tbl := fsTableOf(c)

	// Stat first: a directory takes the no-fd path (nvim opens dirs to getdents
	// them, but we serve those via fs.readdir).
	if fi, serr := os.Stat(path); serr == nil && fi.IsDir() {
		id := tbl.add(&fsHandle{path: path, isDir: true})
		return Response{Result: map[string]any{"handle": id, "size": fi.Size(), "isDir": true}}, nil
	}

	// Translate the musl flag bits to Go open flags. The numeric values match
	// Linux, but translating explicitly keeps it correct + portable.
	acc := p.Flags & oACCMODE
	goFlag := os.O_RDONLY
	switch acc {
	case xWRONLY:
		goFlag = os.O_WRONLY
	case xRDWR:
		goFlag = os.O_RDWR
	}
	if p.Flags&xCREAT != 0 {
		goFlag |= os.O_CREATE
	}
	if p.Flags&xEXCL != 0 {
		goFlag |= os.O_EXCL
	}
	if p.Flags&xTRUNC != 0 {
		goFlag |= os.O_TRUNC
	}
	if p.Flags&xAPPEND != 0 {
		goFlag |= os.O_APPEND
	}
	mode := os.FileMode(0o644)
	if p.Mode != nil && *p.Mode != 0 {
		mode = os.FileMode(*p.Mode)
	}

	f, oerr := os.OpenFile(path, goFlag, mode)
	if oerr != nil {
		return Response{}, oerr
	}
	size := int64(0)
	if fi, serr := f.Stat(); serr == nil {
		size = fi.Size()
	}
	id := tbl.add(&fsHandle{path: path, f: f})
	return Response{Result: map[string]any{"handle": id, "size": size, "isDir": false}}, nil
}

func fsRead(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	p, err := decodeFS(params)
	if err != nil {
		return Response{}, err
	}
	length := p.Len
	if length < 0 {
		length = 0
	}
	pos := p.Pos
	if pos < 0 {
		pos = 0
	}
	buf := make([]byte, length)

	read := func(f *os.File) (int, error) {
		n, rerr := f.ReadAt(buf, int64(pos))
		if rerr != nil && rerr != io.EOF {
			return n, rerr
		}
		return n, nil
	}

	var n int
	if p.Handle != nil {
		if h := fsTableOf(c).get(*p.Handle); h != nil && h.f != nil {
			n, err = read(h.f)
			if err != nil {
				return Response{}, err
			}
		}
	} else {
		path, jerr := resolveJailed(c.Config.Root, p.Path)
		if jerr != nil {
			return Response{}, jerr
		}
		f, oerr := os.Open(path)
		if oerr != nil {
			return Response{}, oerr
		}
		n, err = read(f)
		f.Close()
		if err != nil {
			return Response{}, err
		}
	}
	out := buf
	if n < length {
		out = buf[:n]
	}
	return Response{
		Result:  map[string]any{"n": n, "eof": n < length},
		Payload: out,
	}, nil
}

func fsWrite(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	p, err := decodeFS(params)
	if err != nil {
		return Response{}, err
	}
	pos := p.Pos
	if pos < 0 {
		pos = 0
	}
	var n int
	if p.Handle != nil {
		if h := fsTableOf(c).get(*p.Handle); h != nil && h.f != nil {
			n, err = h.f.WriteAt(payload, int64(pos))
			if err != nil {
				return Response{}, err
			}
		}
	} else {
		path, jerr := resolveJailed(c.Config.Root, p.Path)
		if jerr != nil {
			return Response{}, jerr
		}
		f, oerr := os.OpenFile(path, os.O_RDWR, 0o644)
		if oerr != nil {
			f, oerr = os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
			if oerr != nil {
				return Response{}, oerr
			}
		}
		n, err = f.WriteAt(payload, int64(pos))
		f.Close()
		if err != nil {
			return Response{}, err
		}
	}
	return Response{Result: map[string]any{"n": n}}, nil
}

func fsClose(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	p, err := decodeFS(params)
	if err != nil {
		return Response{}, err
	}
	if p.Handle != nil {
		if h := fsTableOf(c).remove(*p.Handle); h != nil && h.f != nil {
			h.f.Close()
		}
	}
	return Response{Result: map[string]any{"ok": true}}, nil
}

func fsStat(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	p, err := decodeFS(params)
	if err != nil {
		return Response{}, err
	}
	path, err := resolveJailed(c.Config.Root, p.Path)
	if err != nil {
		return Response{}, err
	}
	fi, serr := os.Stat(path)
	if serr != nil {
		return Response{Result: map[string]any{"exists": false}}, nil
	}
	return Response{Result: statShape(fi, false)}, nil
}

func fsLstat(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	p, err := decodeFS(params)
	if err != nil {
		return Response{}, err
	}
	path, err := resolveJailed(c.Config.Root, p.Path)
	if err != nil {
		return Response{}, err
	}
	fi, serr := os.Lstat(path)
	if serr != nil {
		return Response{Result: map[string]any{"exists": false}}, nil
	}
	return Response{Result: statShape(fi, true)}, nil
}

func fsReaddir(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	p, err := decodeFS(params)
	if err != nil {
		return Response{}, err
	}
	path, err := resolveJailed(c.Config.Root, p.Path)
	if err != nil {
		return Response{}, err
	}
	ents, rerr := os.ReadDir(path)
	if rerr != nil {
		return Response{}, rerr
	}
	entries := make([]map[string]any, 0, len(ents))
	for _, d := range ents {
		isDir := d.IsDir()
		// A symlink-to-dir should list as a dir for nvim's browser; resolve it.
		if d.Type()&os.ModeSymlink != 0 {
			if fi, serr := os.Stat(filepath.Join(path, d.Name())); serr == nil {
				isDir = fi.IsDir()
			} else {
				isDir = false
			}
		}
		entries = append(entries, map[string]any{"name": d.Name(), "isDir": isDir})
	}
	return Response{Result: map[string]any{"entries": entries}}, nil
}

func fsMkdir(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	p, err := decodeFS(params)
	if err != nil {
		return Response{}, err
	}
	path, err := resolveJailed(c.Config.Root, p.Path)
	if err != nil {
		return Response{}, err
	}
	mode := os.FileMode(0o755)
	if p.Mode != nil && *p.Mode != 0 {
		mode = os.FileMode(*p.Mode & 0o777)
	}
	if merr := os.Mkdir(path, mode); merr != nil {
		return Response{}, merr
	}
	return Response{Result: map[string]any{"ok": true}}, nil
}

func fsUnlink(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	p, err := decodeFS(params)
	if err != nil {
		return Response{}, err
	}
	path, err := resolveJailed(c.Config.Root, p.Path)
	if err != nil {
		return Response{}, err
	}
	// dir:true -> rmdir; else unlink (use syscall so a file unlink can't rmdir a
	// directory, matching the Node unlink/rmdir split).
	if p.Dir {
		if rerr := syscall.Rmdir(path); rerr != nil {
			return Response{}, rerr
		}
	} else {
		if uerr := syscall.Unlink(path); uerr != nil {
			return Response{}, uerr
		}
	}
	return Response{Result: map[string]any{"ok": true}}, nil
}

func fsRename(c *Ctx, params json.RawMessage, payload []byte) (Response, error) {
	p, err := decodeFS(params)
	if err != nil {
		return Response{}, err
	}
	from, err := resolveJailed(c.Config.Root, p.From)
	if err != nil {
		return Response{}, err
	}
	to, err := resolveJailed(c.Config.Root, p.To)
	if err != nil {
		return Response{}, err
	}
	if rerr := os.Rename(from, to); rerr != nil {
		return Response{}, rerr
	}
	return Response{Result: map[string]any{"ok": true}}, nil
}
