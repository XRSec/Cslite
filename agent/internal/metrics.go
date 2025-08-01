package internal

import (
	"bufio"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func collectMetrics() *SystemMetrics {
	return &SystemMetrics{
		CPUUsage:   getCPUUsage(),
		MemoryUsed: getMemoryUsage(),
		DiskUsage:  getDiskUsage(),
	}
}

func getCPUUsage() float64 {
	if runtime.GOOS == "linux" {
		return getLinuxCPUUsage()
	}
	return 0.0
}

func getLinuxCPUUsage() float64 {
	file, err := os.Open("/proc/stat")
	if err != nil {
		return 0.0
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	if scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 5 || fields[0] != "cpu" {
			return 0.0
		}

		user, _ := strconv.ParseFloat(fields[1], 64)
		nice, _ := strconv.ParseFloat(fields[2], 64)
		system, _ := strconv.ParseFloat(fields[3], 64)
		idle, _ := strconv.ParseFloat(fields[4], 64)

		total := user + nice + system + idle
		if total == 0 {
			return 0.0
		}

		usage := ((total - idle) / total) * 100
		return usage
	}

	return 0.0
}

func getMemoryUsage() int {
	if runtime.GOOS == "linux" {
		return getLinuxMemoryUsage()
	}
	return 0
}

func getLinuxMemoryUsage() int {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer file.Close()

	var total, available int64
	scanner := bufio.NewScanner(file)
	
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}

		switch fields[0] {
		case "MemTotal:":
			total, _ = strconv.ParseInt(fields[1], 10, 64)
		case "MemAvailable:":
			available, _ = strconv.ParseInt(fields[1], 10, 64)
		}
	}

	if total > 0 && available > 0 {
		used := total - available
		return int(used / 1024)
	}

	return 0
}

func getDiskUsage() float64 {
	var stat syscall.Statfs_t
	err := syscall.Statfs("/", &stat)
	if err != nil {
		return 0.0
	}

	total := stat.Blocks * uint64(stat.Bsize)
	free := stat.Bfree * uint64(stat.Bsize)
	used := total - free

	if total == 0 {
		return 0.0
	}

	return float64(used) / float64(total) * 100
}

func getPlatform() string {
	return runtime.GOOS + "/" + runtime.GOARCH
}

var lastCPUStats struct {
	user   float64
	nice   float64
	system float64
	idle   float64
	time   time.Time
}