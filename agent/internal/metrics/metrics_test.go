package metrics

import (
	"math"
	"testing"
)

func TestParseProcStatAndDelta(t *testing.T) {
	stat1 := `cpu  1000 50 500 8000 100 50 50 0 0 0
cpu0 500 25 250 4000 50 25 25 0 0 0
`
	stat2 := `cpu  1300 50 700 8400 150 75 75 0 0 0
cpu0 650 25 350 4200 75 37 37 0 0 0
`
	s1, err := ParseProcStat(stat1)
	if err != nil {
		t.Fatalf("ParseProcStat(stat1) failed: %v", err)
	}
	s2, err := ParseProcStat(stat2)
	if err != nil {
		t.Fatalf("ParseProcStat(stat2) failed: %v", err)
	}
	// s1: total = 9750, idle = 8100
	// s2: total = 10750 (+1000), idle = 8550 (+450) -> active = 550/1000 = 55.0%
	got := ComputeCPUUsage(s1, s2)
	if math.Abs(got-55.0) > 0.01 {
		t.Fatalf("ComputeCPUUsage = %.2f, want 55.00", got)
	}
}

func TestParseProcMeminfoModernAndLegacyOpenWrt(t *testing.T) {
	modern := `MemTotal:        2048000 kB
MemFree:          256000 kB
MemAvailable:    1024000 kB
Buffers:           64000 kB
Cached:           512000 kB
`
	usedMB, totalMB, pct := ParseProcMeminfo(modern)
	if usedMB != 1000 || totalMB != 2000 || math.Abs(pct-50.0) > 0.01 {
		t.Fatalf("modern ParseProcMeminfo = (%d, %d, %.2f), want (1000, 2000, 50.00)", usedMB, totalMB, pct)
	}

	// Older OpenWrt kernels lack MemAvailable -> fallback to MemFree+Buffers+Cached+SReclaimable.
	openwrtLegacy := `MemTotal:         131072 kB
MemFree:           32768 kB
Buffers:            8192 kB
Cached:            24576 kB
`
	// available = 65536 kB (64MB), used = 65536 kB (64MB) of 128MB -> 50%
	usedMB, totalMB, pct = ParseProcMeminfo(openwrtLegacy)
	if usedMB != 64 || totalMB != 128 || math.Abs(pct-50.0) > 0.01 {
		t.Fatalf("legacy OpenWrt ParseProcMeminfo = (%d, %d, %.2f), want (64, 128, 50.00)", usedMB, totalMB, pct)
	}
}

func TestParseProcNetDevIgnoresLoopback(t *testing.T) {
	dev1 := `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999999   100    0    0    0     0          0         0  9999999   100    0    0    0     0       0          0
  eth0: 1024000   500    0    0    0     0          0         0   512000   400    0    0    0     0       0          0
 wlan0:  512000   100    0    0    0     0          0         0   256000   100    0    0    0     0       0          0
`
	dev2 := `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 19999999  200    0    0    0     0          0         0 19999999   200    0    0    0     0       0          0
  eth0: 1228800   600    0    0    0     0          0         0   614400   500    0    0    0     0       0          0
 wlan0:  512000   100    0    0    0     0          0         0   256000   100    0    0    0     0       0          0
`
	s1 := ParseProcNetDev(dev1)
	s2 := ParseProcNetDev(dev2)
	// Delta over 2 seconds: rx = +204800 bytes = 200 KB -> 100 KB/s; tx = +102400 bytes = 100 KB -> 50 KB/s.
	inKBps, outKBps := ComputeNetRate(s1, s2, 2.0)
	if inKBps != 100 || outKBps != 50 {
		t.Fatalf("ComputeNetRate = (%d, %d), want (100, 50)", inKBps, outKBps)
	}
}

func TestParseLoadavgUptimeAndRelease(t *testing.T) {
	if got := ParseProcLoadavg("0.42 0.35 0.28 1/234 5678\n"); got != "0.42 0.35 0.28" {
		t.Fatalf("ParseProcLoadavg = %q", got)
	}
	if got := ParseProcUptime("12345.67 89012.34\n"); got != 12345 {
		t.Fatalf("ParseProcUptime = %d, want 12345", got)
	}
	owrt := "DISTRIB_ID='OpenWrt'\nDISTRIB_RELEASE='23.05.3'\nDISTRIB_DESCRIPTION='OpenWrt 23.05.3 r23809'\n"
	if got := ParseKeyValueRelease(owrt, "DISTRIB_DESCRIPTION", "DISTRIB_RELEASE"); got != "OpenWrt 23.05.3 r23809" {
		t.Fatalf("ParseKeyValueRelease = %q", got)
	}
}
