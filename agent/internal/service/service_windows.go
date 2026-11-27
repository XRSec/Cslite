//go:build windows

package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// DetectInitSystem returns "windows-scm" on Windows.
func DetectInitSystem() string {
	return "windows-scm"
}

// IsWindowsService reports whether the current process was started by the Windows SCM.
func IsWindowsService() bool {
	isSvc, err := svc.IsWindowsService()
	return err == nil && isSvc
}

type scmHandler struct {
	runner func(ctx context.Context) error
}

func (h *scmHandler) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown
	changes <- svc.Status{State: svc.StartPending}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		errCh <- h.runner(ctx)
	}()

	changes <- svc.Status{State: svc.Running, Accepts: accepted}

	for {
		select {
		case err := <-errCh:
			changes <- svc.Status{State: svc.StopPending}
			if err != nil && !errors.Is(err, context.Canceled) {
				return true, 1
			}
			return false, 0

		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				changes <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				cancel()
				select {
				case <-errCh:
				case <-time.After(15 * time.Second):
				}
				return false, 0
			}
		}
	}
}

// RunWindowsService runs runner under the Windows Service Control Manager lifecycle.
func RunWindowsService(name string, runner func(ctx context.Context) error) error {
	if name == "" {
		name = ServiceName
	}
	return svc.Run(name, &scmHandler{runner: runner})
}

// Install registers and starts the Cslite Agent Windows service.
func Install(opts Options) error {
	if opts.UserMode {
		return errors.New("Windows SCM services run system-wide; omit --user and run from an elevated Administrator shell")
	}

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect SCM: %w", err)
	}
	defer m.Disconnect()

	if existing, err := m.OpenService(ServiceName); err == nil {
		_ = stopServiceWait(existing)
		_ = existing.Delete()
		existing.Close()
		time.Sleep(500 * time.Millisecond)
	}

	s, err := m.CreateService(
		ServiceName,
		opts.BinaryPath,
		mgr.Config{
			DisplayName: "Cslite Agent",
			Description: "Cslite lightweight cross-platform command execution agent",
			StartType:   mgr.StartAutomatic,
		},
		"run", "--config", opts.ConfigPath,
	)
	if err != nil {
		return fmt.Errorf("create service: %w", err)
	}
	defer s.Close()

	_ = s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 15 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
	}, 86400)

	if err := s.Start(); err != nil {
		return fmt.Errorf("start service: %w", err)
	}
	return nil
}

// Uninstall stops and deletes the Cslite Agent Windows service.
func Uninstall(_ Options) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(ServiceName)
	if err != nil {
		return nil
	}
	defer s.Close()

	_ = stopServiceWait(s)
	return s.Delete()
}

// Start starts the Windows service.
func Start(_ Options) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()

	s, err := m.OpenService(ServiceName)
	if err != nil {
		return err
	}
	defer s.Close()
	return s.Start()
}

// Stop stops the Windows service.
func Stop(_ Options) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()

	s, err := m.OpenService(ServiceName)
	if err != nil {
		return err
	}
	defer s.Close()
	return stopServiceWait(s)
}

// Restart stops and starts the Windows service.
func Restart(opts Options) error {
	_ = Stop(opts)
	return Start(opts)
}

// Status queries the Windows service status.
func Status(_ Options) (string, error) {
	m, err := mgr.Connect()
	if err != nil {
		return "unknown", err
	}
	defer m.Disconnect()

	s, err := m.OpenService(ServiceName)
	if err != nil {
		return "not installed", nil
	}
	defer s.Close()

	st, err := s.Query()
	if err != nil {
		return "unknown", err
	}
	switch st.State {
	case svc.Running:
		return "running (windows-scm)", nil
	case svc.Stopped:
		return "stopped (windows-scm)", nil
	case svc.StartPending:
		return "start-pending (windows-scm)", nil
	case svc.StopPending:
		return "stop-pending (windows-scm)", nil
	default:
		return fmt.Sprintf("state=%d (windows-scm)", st.State), nil
	}
}

func stopServiceWait(s *mgr.Service) error {
	status, err := s.Control(svc.Stop)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(15 * time.Second)
	for status.State != svc.Stopped && time.Now().Before(deadline) {
		time.Sleep(300 * time.Millisecond)
		status, err = s.Query()
		if err != nil {
			return err
		}
	}
	return nil
}
