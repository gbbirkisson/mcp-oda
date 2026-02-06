.DEFAULT_GOAL:=help

NPM:=npm
NPX:=npx

.PHONY: install
install:  ## Install dependencies and browsers
	${NPM} install
	${NPX} playwright install chromium

.PHONY: build
build:  ## Build the project
	${NPM} run build

.PHONY: test
test:  ## Run tests (run once)
	${NPM} test -- run

.PHONY: run
run: build  ## Run the MCP server
	${NPM} start

.PHONY: inspector
inspector: build  ## Run mcp inspector for testing
	npx @modelcontextprotocol/inspector node dist/index.js --headed

.PHONY: clean
clean:  ## Clean build artifacts
	rm -rf dist node_modules

help: ## Show this help
	$(eval HELP_COL_WIDTH:=13)
	@echo "Makefile targets:"
	@grep -E '[^\s]+:.*?## .*$$' ${MAKEFILE_LIST} | grep -v grep | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-${HELP_COL_WIDTH}s\033[0m %s\n", $$1, $$2}'
