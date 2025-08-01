.PHONY: all build-server build-agent clean test run-server run-agent

# Variables
SERVER_BIN=server/cslite-server
AGENT_BIN=agent/cslite-agent
GO=go
GOFLAGS=-v

all: build-server build-agent

build-server:
	@echo "Building server..."
	cd server && $(GO) build $(GOFLAGS) -o cslite-server main.go

build-agent:
	@echo "Building agent..."
	cd agent && $(GO) build $(GOFLAGS) -o cslite-agent main.go

build-agent-all:
	@echo "Building agent for all platforms..."
	cd agent && GOOS=linux GOARCH=amd64 $(GO) build -o cslite-agent-linux-amd64 main.go
	cd agent && GOOS=linux GOARCH=arm64 $(GO) build -o cslite-agent-linux-arm64 main.go
	cd agent && GOOS=darwin GOARCH=amd64 $(GO) build -o cslite-agent-darwin-amd64 main.go
	cd agent && GOOS=darwin GOARCH=arm64 $(GO) build -o cslite-agent-darwin-arm64 main.go
	cd agent && GOOS=windows GOARCH=amd64 $(GO) build -o cslite-agent-windows-amd64.exe main.go

clean:
	@echo "Cleaning..."
	rm -f $(SERVER_BIN) $(AGENT_BIN)
	rm -f agent/cslite-agent-*

test:
	@echo "Running tests..."
	cd server && $(GO) test ./...
	cd agent && $(GO) test ./...

run-server: build-server
	@echo "Running server..."
	cd server && ./cslite-server

run-agent: build-agent
	@echo "Running agent..."
	cd agent && ./cslite-agent

docker-build:
	@echo "Building Docker images..."
	docker build -t cslite/server:latest -f docker/Dockerfile.server .
	docker build -t cslite/agent:latest -f docker/Dockerfile.agent .

install-deps:
	@echo "Installing dependencies..."
	cd server && $(GO) mod download
	cd agent && $(GO) mod download