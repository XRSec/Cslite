//go:build darwin

package metrics

import (
	"context"
	"os"
	osexec "os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/XRSec/Cslite/agent/internal/protocol"
)

// DetectPlatform gathers macOS platform, architecture, and OS version cleanly without CGO.
func DetectPlatform() PlatformInfo {
	hostname, _ := os.Hostname()
	osVer := runShortCmd("sw_vers", "-productVersion")
	if osVer != "" {
		osVer = "macOS " + osVer
	} else {
		osVer = runShortCmd("uname", "-r")
	}
	return PlatformInfo{
		Platform:  "macos",
		Arch:      runtime.GOARCH,
		OSVersion: osVer,
		Hostname:  hostname,
	}
}

func (c *Collector) prime() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if netSample, ok := readDarwinNetDev(); ok {
		c.prevNet = netSample
		c.prevNetTime = time.Now()
		c.hasPrevNet = true
	}
}

func (c *Collector) collectPlatform() *protocol.DeviceMetrics {
	m := &protocol.DeviceMetrics{}

	m.DiskUsage, m.DiskTotal = readDarwinDiskUsage("/")
	m.MemoryUsed, m.MemoryTotal, m.MemoryPercent = readDarwinMemory()
	m.LoadAvg = readDarwinLoadAvg()
	m.Uptime = readDarwinUptime()
	m.CPUUsage = readDarwinCPUUsage()

	c.mu.Lock()
	if curr, ok := readDarwinNetDev(); ok {
		now := time.Now()
		if c.hasPrevNet {
			m.NetworkIn, m.NetworkOut = ComputeNetRate(c.prevNet, curr, now.Sub(c.prevNetTime).Seconds())
		}
		c.prevNet = curr
		c.prevNetTime = now
		c.hasPrevNet = true
	}
	c.mu.Unlock()

	return m
}

func runShortCmd(name string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := osexec.CommandContext(ctx, name, args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func readDarwinDiskUsage(path string) (float64, int64) {
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
	return round2(float64(used) / float64(total) * 100.0), int64(total / (1024 * 1024))
}

func readDarwinMemory() (usedMB int, totalMB int, percent float64) {
	memOut := runShortCmd("sysctl", "-n", "hw.memsize")
	totalBytes, err := strconv.ParseUint(memOut, 10, 64)
	if err != nil || totalBytes == 0 {
		return 0, 0, 0
	}
	totalMB = int(totalBytes / (1024 * 1024))

	vmOut := runShortCmd("vm_stat")
	if vmOut == "" {
		return 0, totalMB, 0
	}

	var pageSize uint64 = 4096
	var active, wired, compressed uint64

	for _, line := range strings.Split(vmOut, "\n") {
		if strings.Contains(line, "page size of") {
			for _, f := range strings.Fields(line) {
				if v, err := strconv.ParseUint(f, 10, 64); err == nil && v >= 4096 {
					pageSize = v
					break
				}
			}
			continue
		}
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue
		}
		key := strings.TrimSpace(line[:colon])
		valStr := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(line[colon+1:]), "."))
		val, err := strconv.ParseUint(valStr, 10, 64)
		if err != nil {
			continue
		}
		switch key {
		case "Pages active":
			active = val
		case "Pages wired down":
			wired = val
		case "Pages occupied by compressor":
			compressed = val
		}
	}

	usedBytes := (active + wired + compressed) * pageSize
	if usedBytes > totalBytes {
		usedBytes = totalBytes
	}
	usedMB = int(usedBytes / (1024 * 1024))
	percent = round2(float64(usedBytes) / float64(totalBytes) * 100.0)
	return usedMB, totalMB, percent
}

func readDarwinLoadAvg() string {
	out := runShortCmd("sysctl", "-n", "vm.loadavg")
	out = strings.Trim(out, "{} ")
	fields := strings.Fields(out)
	if len(fields) < 3 {
		return ""
	}
	return fields[0] + " " + fields[1] + " " + fields[2]
}

func readDarwinUptime() int64 {
	out := runShortCmd("sysctl", "-n", "kern.boottime")
	// Format: { sec = 1732600000, usec = 0 } ...
	idx := strings.Index(out, "sec =")
	if idx < 0 {
		return 0
	}
	rest := strings.TrimSpace(out[idx+5:])
	comma := strings.IndexByte(rest, ',')
	if comma > 0 {
		rest = rest[:comma]
	}
	bootSec, err := strconv.ParseInt(strings.TrimSpace(rest), 10, 64)
	if err != nil || bootSec <= 0 {
		return 0
	}
	up := time.Now().Unix() - bootSec
	if up < 0 {
		return 0
	}
	return up
}

func readDarwinCPUUsage() float64 {
	out := runShortCmd("ps", "-A", "-o", "%cpu")
	if out == "" {
		return 0
	}
	var sum float64
	for i, line := range strings.Split(out, "\n") {
		if i == 0 {
			continue
		}
		v, err := strconv.ParseFloat(strings.TrimSpace(line), 64)
		if err == nil && v >= 0 {
			sum += v
		}
	}
	cpus := float64(runtime.NumCPU())
	if cpus <= 0 {
		cpus = 1
	}
	pct := sum / cpus
	if pct > 100 {
		pct = 100
	}
	return round2(pct)
}

func readDarwinNetDev() (NetSample, bool) {
	out := runShortCmd("netstat", "-ibn")
	if out == "" {
		return NetSample{}, false
	}
	var sample NetSample
	seen := make(map[string]struct{})
	for i, line := range strings.Split(out, "\n") {
		if i == 0 {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 10 {
			continue
		}
		iface := fields[0]
		if strings.HasPrefix(iface, "lo") {
			continue
		}
		if !strings.HasPrefix(fields[2], "<Link#") {
			continue
		}
		if _, ok := seen[iface]; ok {
			continue
		}
		seen[iface] = struct{}{}

		// Link row columns: Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes [Coll]
		ibytesIdx := len(fields) - 5
		obytesIdx := len(fields) - 2
		if len(fields) == 10 {
			// When Address is blank, fields shift by 1 (10 cols instead of 11).
			ibytesIdx = 5
			obytesIdx = 8
		} else if len(fields) >= 11 {
			ibytesIdx = 6
			obytesIdx = 9
		}
		rx, err1 := strconv.ParseUint(fields[ibytesIdx], 10, 64)
		tx, err2 := strconv.ParseUint(fields[obytesIdx], 10, 64)
		if err1 == nil && err2 == nil {
			sample.RxBytes += rx
			sample.TxBytes += tx
		}
	}
	return sample, true
}
