package metrics

import (
	"errors"
	"strconv"
	"strings"
)

// CPUSample stores cumulative jiffies/ticks for delta calculation.
type CPUSample struct {
	Total uint64
	Idle  uint64
}

// NetSample stores cumulative rx/tx bytes across non-loopback interfaces.
type NetSample struct {
	RxBytes uint64
	TxBytes uint64
}

// ParseProcStat parses the aggregate "cpu " line from Linux /proc/stat.
func ParseProcStat(content string) (CPUSample, error) {
	for _, line := range strings.Split(content, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 || fields[0] != "cpu" {
			continue
		}
		var vals [8]uint64
		limit := len(fields) - 1
		if limit > 8 {
			limit = 8
		}
		for i := 0; i < limit; i++ {
			v, err := strconv.ParseUint(fields[i+1], 10, 64)
			if err != nil {
				return CPUSample{}, err
			}
			vals[i] = v
		}
		// user, nice, system, idle, iowait, irq, softirq, steal
		var total uint64
		for i := 0; i < limit; i++ {
			total += vals[i]
		}
		idle := vals[3]
		if limit > 4 {
			idle += vals[4] // iowait
		}
		return CPUSample{Total: total, Idle: idle}, nil
	}
	return CPUSample{}, errors.New("cpu line not found in /proc/stat")
}

// ComputeCPUUsage returns percentage CPU utilization [0, 100] from two samples.
func ComputeCPUUsage(prev, curr CPUSample) float64 {
	if curr.Total <= prev.Total {
		return 0
	}
	totalDelta := curr.Total - prev.Total
	var idleDelta uint64
	if curr.Idle >= prev.Idle {
		idleDelta = curr.Idle - prev.Idle
	}
	if idleDelta >= totalDelta {
		return 0
	}
	usage := float64(totalDelta-idleDelta) / float64(totalDelta) * 100.0
	if usage < 0 {
		return 0
	}
	if usage > 100 {
		return 100
	}
	return round2(usage)
}

// ParseProcMeminfo parses /proc/meminfo with fallback for older OpenWrt kernels lacking MemAvailable.
func ParseProcMeminfo(content string) (usedMB int, totalMB int, percent float64) {
	var total, available, free, buffers, cached, sReclaimable uint64
	var hasAvailable bool

	for _, line := range strings.Split(content, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		val, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			total = val
		case "MemAvailable:":
			available = val
			hasAvailable = true
		case "MemFree:":
			free = val
		case "Buffers:":
			buffers = val
		case "Cached:":
			cached = val
		case "SReclaimable:":
			sReclaimable = val
		}
	}

	if total == 0 {
		return 0, 0, 0
	}
	if !hasAvailable {
		available = free + buffers + cached + sReclaimable
	}
	if available > total {
		available = total
	}
	usedKB := total - available
	usedMB = int(usedKB / 1024)
	totalMB = int(total / 1024)
	percent = round2(float64(usedKB) / float64(total) * 100.0)
	return usedMB, totalMB, percent
}

// ParseProcNetDev sums rx/tx bytes from /proc/net/dev ignoring loopback ("lo").
func ParseProcNetDev(content string) NetSample {
	var sample NetSample
	lines := strings.Split(content, "\n")
	for i, line := range lines {
		if i < 2 {
			continue
		}
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue
		}
		iface := strings.TrimSpace(line[:colon])
		if iface == "" || iface == "lo" {
			continue
		}
		fields := strings.Fields(line[colon+1:])
		if len(fields) < 9 {
			continue
		}
		rx, err1 := strconv.ParseUint(fields[0], 10, 64)
		tx, err2 := strconv.ParseUint(fields[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		sample.RxBytes += rx
		sample.TxBytes += tx
	}
	return sample
}

// ComputeNetRate calculates KB/s network in/out rates from two samples and elapsed seconds.
func ComputeNetRate(prev, curr NetSample, elapsedSec float64) (inKBps int, outKBps int) {
	if elapsedSec <= 0 {
		return 0, 0
	}
	if curr.RxBytes >= prev.RxBytes {
		inKBps = int(float64(curr.RxBytes-prev.RxBytes) / elapsedSec / 1024.0)
	}
	if curr.TxBytes >= prev.TxBytes {
		outKBps = int(float64(curr.TxBytes-prev.TxBytes) / elapsedSec / 1024.0)
	}
	return inKBps, outKBps
}

// ParseProcLoadavg extracts 1/5/15m load average from /proc/loadavg.
func ParseProcLoadavg(content string) string {
	fields := strings.Fields(content)
	if len(fields) < 3 {
		return ""
	}
	return fields[0] + " " + fields[1] + " " + fields[2]
}

// ParseProcUptime parses integer uptime seconds from /proc/uptime.
func ParseProcUptime(content string) int64 {
	fields := strings.Fields(content)
	if len(fields) < 1 {
		return 0
	}
	f, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || f < 0 {
		return 0
	}
	return int64(f)
}

// ParseKeyValueRelease extracts values from /etc/openwrt_release or /etc/os-release.
func ParseKeyValueRelease(content string, keys ...string) string {
	kv := make(map[string]string)
	for _, rawLine := range strings.Split(content, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.IndexByte(line, '=')
		if idx <= 0 {
			continue
		}
		k := strings.TrimSpace(line[:idx])
		v := strings.TrimSpace(line[idx+1:])
		v = strings.Trim(v, `"'`)
		kv[k] = v
	}
	for _, k := range keys {
		if v := strings.TrimSpace(kv[k]); v != "" {
			return v
		}
	}
	return ""
}
