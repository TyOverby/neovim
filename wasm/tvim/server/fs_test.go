package server

import (
	"os"
	"path/filepath"
	"testing"
)

// TestResolvePath: engine paths are server paths; resolvePath just forces them
// absolute and cleans them (no jail — the whole filesystem is exposed).
func TestResolvePath(t *testing.T) {
	cases := map[string]string{
		"":                  "/",
		"/":                 "/",
		"/a.txt":            "/a.txt",
		"a.txt":             "/a.txt",
		"/sub/../sub/x":     "/sub/x",
		"/sub//x":           "/sub/x",
		"/../..":            "/",
		"/../../etc/passwd": "/etc/passwd", // climbs clamp at the real root
	}
	for in, want := range cases {
		if got := resolvePath(in); got != want {
			t.Errorf("resolvePath(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestResolveCwd: an existing engine cwd is used as-is (it IS a server path); a
// MEMFS-only / missing cwd and an empty cwd fall back to the connection's Dir.
func TestResolveCwd(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "f.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := ConnConfig{Dir: dir}

	for in, want := range map[string]string{
		"":                     dir, // empty -> Dir
		sub:                    sub, // existing dir -> itself
		"/root/does-not-exist": dir, // MEMFS-only overlay path -> Dir
		file:                   dir, // not a directory -> Dir
		".":                    dir, // relative (engine absolutizes; never anchor at /) -> Dir
	} {
		got, err := resolveCwd(cfg, in)
		if err != nil {
			t.Fatalf("resolveCwd(%q): %v", in, err)
		}
		if got != want {
			t.Errorf("resolveCwd(%q) = %q, want %q", in, got, want)
		}
	}

	// With no Dir configured, fall back to the process cwd.
	got, err := resolveCwd(ConnConfig{}, "/does/not/exist")
	if err != nil {
		t.Fatal(err)
	}
	wd, _ := os.Getwd()
	if got != wd {
		t.Errorf("no-Dir fallback = %q, want process cwd %q", got, wd)
	}
}
