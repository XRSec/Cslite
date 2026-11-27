.PHONY: all install build-web typecheck dev dev-worker build-scf deploy-worker build-agent build-agent-all build-openwrt-ipk docker-build test clean

NODE ?= node
NPM ?= npm
GO ?= go
WRANGLER ?= wrangler
TSC := ./node_modules/.bin/tsc
TSX := ./node_modules/.bin/tsx
VITEST := ./node_modules/.bin/vitest

AGENT_VERSION ?= v1.0.0
IPK_VERSION := $(patsubst v%,%,$(AGENT_VERSION))
OPENWRT_ARCH ?= x86_64
AGENT_BIN ?=

all: build-web typecheck build-agent

install:
	$(NPM) install
	cd agent && $(GO) mod download

build-web:
	$(NODE) web/build.mjs

typecheck:
	$(TSC) --noEmit
	$(TSC) -p tsconfig.web.json --noEmit

dev: build-web
	$(TSX) watch server/src/entry-node.ts

dev-worker: build-web
	cd server && $(WRANGLER) dev

build-scf: build-web
	bash deploy/scf/build-scf.sh

deploy-worker: build-web
	cd server && $(WRANGLER) deploy

build-agent:
	cd agent && CGO_ENABLED=0 $(GO) build -trimpath -ldflags="-s -w -X main.Version=$(AGENT_VERSION)" -o cslite-agent main.go

build-agent-all:
	mkdir -p dist/agent
	cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build -trimpath -ldflags="-s -w -X main.Version=$(AGENT_VERSION)" -o ../dist/agent/cslite-agent-linux-amd64 main.go
	cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 $(GO) build -trimpath -ldflags="-s -w -X main.Version=$(AGENT_VERSION)" -o ../dist/agent/cslite-agent-linux-arm64 main.go
	cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 $(GO) build -trimpath -ldflags="-s -w -X main.Version=$(AGENT_VERSION)" -o ../dist/agent/cslite-agent-linux-armv7 main.go
	cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=mips GOMIPS=softfloat $(GO) build -trimpath -ldflags="-s -w -X main.Version=$(AGENT_VERSION)" -o ../dist/agent/cslite-agent-linux-mips main.go
	cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=mipsle GOMIPS=softfloat $(GO) build -trimpath -ldflags="-s -w -X main.Version=$(AGENT_VERSION)" -o ../dist/agent/cslite-agent-linux-mipsle main.go
	cd agent && CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 $(GO) build -trimpath -ldflags="-s -w -X main.Version=$(AGENT_VERSION)" -o ../dist/agent/cslite-agent-darwin-amd64 main.go
	cd agent && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 $(GO) build -trimpath -ldflags="-s -w -X main.Version=$(AGENT_VERSION)" -o ../dist/agent/cslite-agent-darwin-arm64 main.go
	cd agent && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 $(GO) build -trimpath -ldflags="-s -w -X main.Version=$(AGENT_VERSION)" -o ../dist/agent/cslite-agent-windows-amd64.exe main.go
	cd agent && CGO_ENABLED=0 GOOS=windows GOARCH=arm64 $(GO) build -trimpath -ldflags="-s -w -X main.Version=$(AGENT_VERSION)" -o ../dist/agent/cslite-agent-windows-arm64.exe main.go

build-openwrt-ipk:
	mkdir -p dist/openwrt
	sh agent/openwrt/build-ipk.sh --lite --version "$(IPK_VERSION)" --out "dist/openwrt/cslite-agent-lite_$(IPK_VERSION)_all.ipk"
	@if [ -n "$(AGENT_BIN)" ]; then \
		sh agent/openwrt/build-ipk.sh --full --arch "$(OPENWRT_ARCH)" --bin "$(AGENT_BIN)" --version "$(IPK_VERSION)" --out "dist/openwrt/cslite-agent_$(IPK_VERSION)_$(OPENWRT_ARCH).ipk"; \
	fi

docker-build:
	docker build -t cslite:latest -f deploy/docker/Dockerfile .

test:
	$(NODE) web/build.mjs
	$(TSC) --noEmit
	$(TSC) -p tsconfig.web.json --noEmit
	$(VITEST) run
	cd agent && $(GO) vet ./... && $(GO) test -race ./...

clean:
	rm -rf agent/cslite-agent* dist web/dist deploy/scf/dist server/.wrangler
