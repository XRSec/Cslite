//go:build linux

package metrics

import (
	"os"
	"runtime"
	"syscall"
	"time"

	"github.com/XRSec/Cslite/agent/internal/config"
	"github.com/XRSec/Cslite/agent/internal/protocol"
)

// DetectPlatform inspects /etc/openwrt_release and /etc/os-release on Linux.
func DetectPlatform() PlatformInfo {
	hostname, _ := os.Hostname()
	platform := "linux"
	var osVersion string

	if config.IsOpenWrt() {
		platform = "openwrt"
		if raw, err := os.ReadFile("/etc/openwrt_release"); err == nil {
			osVersion = ParseKeyValueRelease(string(raw), "DISTRIB_DESCRIPTION", "DISTRIB_RELEASE")
		}
	}
	if osVersion == "" {
		if raw, err := os.ReadFile("/etc/os-release"); err == nil {
			osVersion = ParseKeyValueRelease(string(raw), "PRETTY_NAME", "VERSION_ID", "NAME")
		}
	}

	return PlatformInfo{
		Platform:  platform,
		Arch:      runtime.GOARCH,
		OSVersion: osVersion,
		Hostname:  hostname,
	}
}

func (c *Collector) prime() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if raw, err := os.ReadFile("/proc/stat"); err == nil {
		if s, err := ParseProcStat(string(raw)); err == nil {
			c.prevCPU = s
			c.hasPrevCPU = true
		}
	}
	if raw, err := os.ReadFile("/proc/net/dev"); err == nil {
		c.prevNet = ParseProcNetDev(string(raw))
		c.prevNetTime = time.Now()
		c.hasPrevNet = true
	}
}

func (c *Collector) collectPlatform() *protocol.DeviceMetrics {
	m := &protocol.DeviceMetrics{}

	c.mu.Lock()
	if raw, err := os.ReadFile("/proc/stat"); err == nil {
		if curr, err := ParseProcStat(string(raw)); err == nil {
			if c.hasPrevCPU {
				m.CPUUsage = ComputeCPUUsage(c.prevCPU, curr)
			}
			c.prevCPU = curr
			c.hasPrevCPU = true
		}
	}

	if raw, err := os.ReadFile("/proc/net/dev"); err == nil {
		curr := ParseProcNetDev(string(raw))
		now := time.Now()
		if c.hasPrevNet {
			m.NetworkIn, m.NetworkOut = ComputeNetRate(c.prevNet, curr, now.Sub(c.prevNetTime).Seconds())
		}
		c.prevNet = curr
		c.prevNetTime = now
		c.hasPrevNet = true
	}
	c.mu.Unlock()

	if raw, err := os.ReadFile("/proc/meminfo"); err == nil {
		m.MemoryUsed, m.MemoryTotal, m.MemoryPercent = ParseProcMeminfo(string(raw))
	}

	m.DiskUsage, m.DiskTotal = readDiskUsage("/")

	if raw, err := os.ReadFile("/proc/loadavg"); err == nil {
		m.LoadAvg = ParseProcLoadavg(string(raw))
	}
	if raw, err := os.ReadFile("/proc/uptime"); err == nil {
		m.Uptime = ParseProcUptime(string(raw))
	}

	return m
}

func readDiskUsage(path string) (usagePct float64, totalMB int64) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, 0
	}
	if stat.Bsize <= 0 || stat.Blocks == 0 {
		return 0, 0
	}
	bsize := uint64(stat.Bsize)
	total := stat.Blocks * bsize
	free := stat.Bfree * bsize
	var used uint64
	if total >= free {
		used = total - free
	}
	usagePct = round2(float64(used) / float64(total) * 100.0)
	totalMB = int64(total / (1024 * 1024))
	return usagePct, totalMB
}
