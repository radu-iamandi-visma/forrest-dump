# Pin a POSIX shell so the recipes work the same whether `make` is launched
# from Git Bash, WSL, or PowerShell. `bash` is what `make dev` was tested
# against; on systems where bash lives elsewhere set SHELL via the env.
SHELL := bash

.PHONY: help dev install build clean

help:
	@echo "Available commands:"
	@echo ""
	@echo "  make install   Install dependencies"
	@echo "  make dev       Start dev server (http://localhost:3000)"
	@echo "  make build     Build for production into ./dist"
	@echo "  make clean     Remove node_modules and dist"
	@echo ""

install:
	npm install

dev:
	@if [ ! -f .env ]; then \
		echo ".env not found — copy .env.example to .env and set VITE_GOOGLE_MAPS_API_KEY."; \
		exit 1; \
	fi
	@if [ ! -d node_modules ]; then npm install; fi
	npm run dev

build:
	npm run build

clean:
	rm -rf node_modules dist
