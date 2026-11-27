// Package state provides atomic persistence for agent registration identity.
package state

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// State stores the agent's bound identity and server URL.
type State struct {
	AgentID   string `json:"agent_id"`
	DeviceID  string `json:"device_id"`
	ServerURL string `json:"server_url"`
}

// Load reads agent state from disk. Returns os.ErrNotExist if absent.
func Load(path string) (*State, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var st State
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, err
	}
	if st.AgentID == "" || st.DeviceID == "" {
		return nil, errors.New("state file incomplete: missing agent_id or device_id")
	}
	return &st, nil
}

// Save writes agent state atomically via a temporary file and rename.
func Save(path string, st *State) error {
	if st == nil {
		return errors.New("nil state")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	tmp, err := os.CreateTemp(dir, ".state-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = tmp.Close()
			_ = os.Remove(tmpPath)
		}
	}()

	if err := tmp.Chmod(0600); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	cleanup = false
	return nil
}

// Clear deletes the state file if it exists.
func Clear(path string) error {
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
