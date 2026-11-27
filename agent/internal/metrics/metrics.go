// Package metrics collects cross-platform host telemetry and OS identity.
package metrics

import (
	"math"
	"sync"
	"time"

	"github.com/XRSec/Cslite/agent/internal/protocol"
)

// PlatformInfo describes the host operating system and architecture.
type PlatformInfo struct {
	Platform  string
	Arch      string
	OSVersion string
	Hostname  string
}

// Collector samples host CPU, memory, disk, network, load, and uptime.
type Collector struct {
	mu          sync.Mutex
	hasPrevCPU  bool
	prevCPU     CPUSample
	hasPrevNet  bool
	prevNet     NetSample
	prevNetTime time.Time
}

// NewCollector creates a Collector and seeds initial CPU/network baselines.
func NewCollector() *Collector {
	c := &Collector{}
	c.prime()
	return c
}

func round2(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(v*100) / 100
}

// Collect gathers current DeviceMetrics safely.
func (c *Collector) Collect() *protocol.DeviceMetrics {
	return c.collectPlatform()
}
