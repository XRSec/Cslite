package state

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveLoadClearAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "state.json")

	want := &State{
		AgentID:   "agent_123",
		DeviceID:  "dev_456",
		ServerURL: "https://example.com/api",
	}
	if err := Save(path, want); err != nil {
		t.Fatalf("Save() failed: %v", err)
	}

	got, err := Load(path)
	if err != nil {
		t.Fatalf("Load() failed: %v", err)
	}
	if *got != *want {
		t.Fatalf("Load() = %+v, want %+v", *got, *want)
	}

	// Overwrite atomically and confirm no temp files remain.
	want2 := &State{
		AgentID:   "agent_789",
		DeviceID:  "dev_000",
		ServerURL: "https://other.example.com/api",
	}
	if err := Save(path, want2); err != nil {
		t.Fatalf("Save() overwrite failed: %v", err)
	}
	got2, err := Load(path)
	if err != nil {
		t.Fatalf("Load() after overwrite failed: %v", err)
	}
	if *got2 != *want2 {
		t.Fatalf("Load() after overwrite = %+v, want %+v", *got2, *want2)
	}

	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatalf("ReadDir() failed: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "state.json" {
		t.Fatalf("unexpected files in state dir: %+v", entries)
	}

	if err := Clear(path); err != nil {
		t.Fatalf("Clear() failed: %v", err)
	}
	if _, err := Load(path); !os.IsNotExist(err) {
		t.Fatalf("Load() after Clear() error = %v, want IsNotExist", err)
	}
	if err := Clear(path); err != nil {
		t.Fatalf("Clear() on missing file failed: %v", err)
	}
}
