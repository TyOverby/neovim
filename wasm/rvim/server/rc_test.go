package server

import (
	"os"
	"path/filepath"
	"testing"
)

// TestRCMode normalises the config flag, empty -> builtin.
func TestRCMode(t *testing.T) {
	for in, want := range map[string]string{
		"remote": "remote", "local": "local", "builtin": "builtin", "": "builtin", "bogus": "builtin",
	} {
		s := &Server{cfg: Config{RC: in}}
		if got := s.rcMode(); got != want {
			t.Errorf("rcMode(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestLocalRCBundle: --rc local collects ~/.config/nvim (rooted at $HOME) into the
// browser MEMFS map; other modes return nil.
func TestLocalRCBundle(t *testing.T) {
	home := t.TempDir()
	cfgDir := filepath.Join(home, ".config", "nvim")
	if err := os.MkdirAll(filepath.Join(cfgDir, "lua"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfgDir, "init.lua"), []byte("vim.o.number = true\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfgDir, "lua", "opts.lua"), []byte("return {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home) // serverHome() honours $HOME via os.UserHomeDir

	if b := (&Server{cfg: Config{RC: "remote"}}).localRCBundle(); b != nil {
		t.Fatalf("non-local mode should not bundle, got %v", b)
	}

	b := (&Server{cfg: Config{RC: "local"}}).localRCBundle()
	if b == nil {
		t.Fatal("local bundle is nil")
	}
	if got := b["/root/.config/nvim/init.lua"]; got != "vim.o.number = true\n" {
		t.Errorf("init.lua = %q", got)
	}
	if _, ok := b["/root/.config/nvim/lua/opts.lua"]; !ok {
		t.Errorf("nested lua/opts.lua missing from bundle: %v", keys(b))
	}
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
