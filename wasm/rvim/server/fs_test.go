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

// TestResolveJailedSymlinkedRoot: when --root itself is a symlink, in-jail paths
// must still resolve and a symlink-escape inside must still be rejected.
func TestResolveJailedSymlinkedRoot(t *testing.T) {
	real := t.TempDir()
	if err := os.MkdirAll(filepath.Join(real, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(real, "sub", "ok.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	_ = os.Symlink(outside, filepath.Join(real, "escape-link"))

	link := filepath.Join(t.TempDir(), "rootlink")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}

	got, err := resolveJailed(link, "/sub/ok.txt")
	if err != nil {
		t.Fatalf("in-jail path under a symlinked root rejected: %v", err)
	}
	realReal, _ := filepath.EvalSymlinks(real)
	if !strings.HasPrefix(got, realReal+string(os.PathSeparator)) {
		t.Fatalf("resolved to %q, expected under %q", got, realReal)
	}
	if _, err := resolveJailed(link, "/escape-link/secret"); err == nil {
		t.Fatal("SECURITY: symlink escape under a symlinked root was not rejected")
	}
}

// TestResolveJailedSiblingPrefix: a sibling dir whose name shares the jail's
// prefix (root `…/jail`, sibling `…/jail-evil`) must NOT be reachable — this is
// exactly what the trailing-separator containment check defends against.
func TestResolveJailedSiblingPrefix(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "jail")
	evil := filepath.Join(base, "jail-evil")
	for _, d := range []string{root, evil} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(evil, "secret"), []byte("s"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, err := resolveJailed(root, "/../jail-evil/secret"); err == nil {
		t.Fatalf("SECURITY: sibling-prefix path escaped the jail, resolved to %q", got)
	}
}

// TestResolveJailedMissingRoot: a non-existent root (EvalSymlinks fails -> Abs
// fallback) must still fail closed on an escaping path.
func TestResolveJailedMissingRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "does-not-exist")
	if got, err := resolveJailed(root, "/../../../../etc/passwd"); err == nil {
		t.Fatalf("SECURITY: escape under a missing root not rejected, resolved to %q", got)
	}
}
