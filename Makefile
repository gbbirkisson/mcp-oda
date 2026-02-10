.DEFAULT_GOAL:=help

NPM:=npm
NPX:=npx

.PHONY: install
install:  ## Install dependencies
	${NPM} install

.PHONY: build
build:  ## Build the project
	${NPM} run build

.PHONY: test
test:  ## Run tests
	${NPM} test

.PHONY: run
run: build  ## Run the MCP server
	${NPM} start

.PHONY: inspector
inspector: build  ## Run mcp inspector for testing
	npx @modelcontextprotocol/inspector ./run.sh

.PHONY: clean
clean:  ## Clean build artifacts
	rm -rf dist node_modules

help: ## Show this help
	$(eval HELP_COL_WIDTH:=13)
	@echo "Makefile targets:"
	@grep -E '[^\s]+:.*?## .*$$' ${MAKEFILE_LIST} | grep -v grep | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-${HELP_COL_WIDTH}s\033[0m %s\n", $$1, $$2}'
