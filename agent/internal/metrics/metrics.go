// Package metrics collects cross-platform host telemetry and OS identity.
package metrics

import (
	"math"
	"net"
	"sort"
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

// FilterAndSortIPs deduplicates IPs, drops loopback/link-local/unspecified/multicast,
// sorts public IPv4 -> private IPv4 -> public IPv6 -> private IPv6, and caps at 128.
func FilterAndSortIPs(raw []net.IP) []string {
	type item struct {
		str   string
		group int
	}
	seen := make(map[string]struct{}, len(raw))
	items := make([]item, 0, len(raw))
	for _, ip := range raw {
		if ip == nil || ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			continue
		}
		if v4 := ip.To4(); v4 != nil {
			ip = v4
		}
		s := ip.String()
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		isV4 := ip.To4() != nil
		isPriv := ip.IsPrivate()
		group := 3
		switch {
		case isV4 && !isPriv:
			group = 0
		case isV4 && isPriv:
			group = 1
		case !isV4 && !isPriv:
			group = 2
		}
		items = append(items, item{str: s, group: group})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].group != items[j].group {
			return items[i].group < items[j].group
		}
		return items[i].str < items[j].str
	})
	if len(items) > 128 {
		items = items[:128]
	}
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.str
	}
	return out
}

// CollectIPAddresses enumerates active interface IPs suitable for telemetry and display.
func CollectIPAddresses() []string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	ips := make([]net.IP, 0, len(addrs))
	for _, addr := range addrs {
		switch v := addr.(type) {
		case *net.IPNet:
			ips = append(ips, v.IP)
		case *net.IPAddr:
			ips = append(ips, v.IP)
		}
	}
	return FilterAndSortIPs(ips)
}

// Collect gathers current DeviceMetrics safely.
func (c *Collector) Collect() *protocol.DeviceMetrics {
	m := c.collectPlatform()
	if m != nil {
		m.IPAddresses = CollectIPAddresses()
	}
	return m
}
