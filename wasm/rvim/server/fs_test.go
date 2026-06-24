package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestResolveJailedContainment is the security unit test for the FS jail: every
// in-root path resolves, and every escape attempt (.., absolute, symlink) is
// rejected before any fs call.
func TestResolveJailedContainment(t *testing.T) {
	root := t.TempDir()
	// Fixtures inside the jail.
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "ok.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A symlink inside the jail pointing OUTSIDE it.
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("s"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.Symlink(outside, filepath.Join(root, "escape-link"))

	allowed := []string{
		"/",
		"/sub",
		"/sub/ok.txt",
		"/sub/../sub/ok.txt", // normalizes back inside
		"/newfile.txt",       // may not exist yet (:w newfile)
		"/sub/newdir/deep",   // missing tail under an existing ancestor
	}
	for _, rel := range allowed {
		got, err := resolveJailed(root, rel)
		if err != nil {
			t.Errorf("expected %q allowed, got error: %v", rel, err)
			continue
		}
		realRoot, _ := filepath.EvalSymlinks(root)
		if got != realRoot && !strings.HasPrefix(got, realRoot+string(os.PathSeparator)) {
			t.Errorf("%q resolved outside root: %q (root %q)", rel, got, realRoot)
		}
	}

	rejected := []string{
		"/../../../../etc/passwd",
		"/../" + filepath.Base(outside) + "/secret",
		"/escape-link/secret",                              // symlink escape: resolves outside the jail
		"/sub/../../" + filepath.Base(outside) + "/secret", // climbs out to the sibling tempdir
	}
	for _, rel := range rejected {
		if got, err := resolveJailed(root, rel); err == nil {
			t.Errorf("SECURITY: expected %q rejected, but it resolved to %q", rel, got)
		}
	}
}

func TestResolveJailedNoRoot(t *testing.T) {
	if _, err := resolveJailed("", "/x"); err == nil {
		t.Fatal("expected error with no jail root")
	}
}
