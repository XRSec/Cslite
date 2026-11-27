//go:build windows

package metrics

import (
	"os"
	"runtime"
	"syscall"
	"unsafe"

	"github.com/XRSec/Cslite/agent/internal/protocol"
	"golang.org/x/sys/windows/registry"
)

var (
	kernel32                 = syscall.NewLazyDLL("kernel32.dll")
	procGetSystemTimes       = kernel32.NewProc("GetSystemTimes")
	procGlobalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
	procGetDiskFreeSpaceExW  = kernel32.NewProc("GetDiskFreeSpaceExW")
	procGetTickCount64       = kernel32.NewProc("GetTickCount64")
)

type fileTime struct {
	LowDateTime  uint32
	HighDateTime uint32
}

func fileTimeToUint64(ft fileTime) uint64 {
	return uint64(ft.HighDateTime)<<32 | uint64(ft.LowDateTime)
}

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

// DetectPlatform returns Windows platform identity via registry without external binaries.
func DetectPlatform() PlatformInfo {
	hostname, _ := os.Hostname()
	osVersion := "Windows"
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion`, registry.QUERY_VALUE); err == nil {
		defer k.Close()
		product, _, _ := k.GetStringValue("ProductName")
		display, _, _ := k.GetStringValue("DisplayVersion")
		build, _, _ := k.GetStringValue("CurrentBuildNumber")
		if product != "" {
			osVersion = product
			if display != "" {
				osVersion += " " + display
			}
			if build != "" {
				osVersion += " (Build " + build + ")"
			}
		}
	}
	return PlatformInfo{
		Platform:  "windows",
		Arch:      runtime.GOARCH,
		OSVersion: osVersion,
		Hostname:  hostname,
	}
}

func (c *Collector) prime() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if s, ok := readWinCPUTimes(); ok {
		c.prevCPU = s
		c.hasPrevCPU = true
	}
}

func (c *Collector) collectPlatform() *protocol.DeviceMetrics {
	m := &protocol.DeviceMetrics{}

	c.mu.Lock()
	if curr, ok := readWinCPUTimes(); ok {
		if c.hasPrevCPU {
			m.CPUUsage = ComputeCPUUsage(c.prevCPU, curr)
		}
		c.prevCPU = curr
		c.hasPrevCPU = true
	}
	c.mu.Unlock()

	m.MemoryUsed, m.MemoryTotal, m.MemoryPercent = readWinMemory()
	m.DiskUsage, m.DiskTotal = readWinDisk(systemDriveRoot())
	m.Uptime = readWinUptime()

	return m
}

func readWinCPUTimes() (CPUSample, bool) {
	var idle, kernel, user fileTime
	r1, _, _ := procGetSystemTimes.Call(
		uintptr(unsafe.Pointer(&idle)),
		uintptr(unsafe.Pointer(&kernel)),
		uintptr(unsafe.Pointer(&user)),
	)
	if r1 == 0 {
		return CPUSample{}, false
	}
	// On Windows, kernel time includes idle time.
	idleT := fileTimeToUint64(idle)
	totalT := fileTimeToUint64(kernel) + fileTimeToUint64(user)
	return CPUSample{Total: totalT, Idle: idleT}, true
}

func readWinMemory() (usedMB int, totalMB int, percent float64) {
	var ms memoryStatusEx
	ms.Length = uint32(unsafe.Sizeof(ms))
	r1, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&ms)))
	if r1 == 0 || ms.TotalPhys == 0 {
		return 0, 0, 0
	}
	var used uint64
	if ms.TotalPhys >= ms.AvailPhys {
		used = ms.TotalPhys - ms.AvailPhys
	}
	usedMB = int(used / (1024 * 1024))
	totalMB = int(ms.TotalPhys / (1024 * 1024))
	percent = round2(float64(used) / float64(ms.TotalPhys) * 100.0)
	return usedMB, totalMB, percent
}

func systemDriveRoot() string {
	drive := os.Getenv("SystemDrive")
	if drive == "" {
		drive = "C:"
	}
	return drive + `\`
}

func readWinDisk(root string) (usagePct float64, totalMB int64) {
	ptr, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return 0, 0
	}
	var freeAvail, totalBytes, totalFree uint64
	r1, _, _ := procGetDiskFreeSpaceExW.Call(
		uintptr(unsafe.Pointer(ptr)),
		uintptr(unsafe.Pointer(&freeAvail)),
		uintptr(unsafe.Pointer(&totalBytes)),
		uintptr(unsafe.Pointer(&totalFree)),
	)
	if r1 == 0 || totalBytes == 0 {
		return 0, 0
	}
	var used uint64
	if totalBytes >= totalFree {
		used = totalBytes - totalFree
	}
	usagePct = round2(float64(used) / float64(totalBytes) * 100.0)
	totalMB = int64(totalBytes / (1024 * 1024))
	return usagePct, totalMB
}

func readWinUptime() int64 {
	r1, _, _ := procGetTickCount64.Call()
	return int64(r1 / 1000)
}
