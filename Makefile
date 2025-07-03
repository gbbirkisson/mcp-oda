.DEFAULT_GOAL:=help

VENV:=.venv
VENV_BIN:=${VENV}/bin
VENV_PYTHON:=${VENV_BIN}/python

RUFF:=${VENV_BIN}/ruff
PYRIGHT:=${VENV_BIN}/pyright

SRC_FILES:=mcp_oda

${VENV}: pyproject.toml uv.lock
	uv python install
	uv venv ${VENV}
	uv sync --all-extras
	touch ${VENV}

.PHONY: install
install:  # Install current commit locally
	pipx install -f .

.PHONY: inspector
inspector: ${VENV}  # Run mcp inspector for testing
	npx @modelcontextprotocol/inspector uv run mcp-oda --headed

.PHONY: ci
ci: lint test  ## Run all CI steps

.PHONY: test
test: ${VENV}  ## Run all tests
	pytest

.PHONY: test-debug
test-debug: ${VENV}  ## Debug test
	PWDEBUG=1 pytest -s -k ${TEST}

.PHONY: lint
lint: ruff pyright  ## Run all linters

.PHONY: ruff
ruff: ${VENV}  ## Run ruff linter
	${RUFF} check ${SRC_FILES}

.PHONY: pyright
pyright: ${VENV}  ## Run pyright linter
	${PYRIGHT} ${SRC_FILES}

.PHONY: format
format: ${VENV}  ## Run formatter on source files
	${RUFF} format ${SRC_FILES}
	${RUFF} check --fix --force-exclude --select=I001 ${SRC_FILES}

.PHONY: clean
clean:  ## Delete virtual environment
	rm -r ${VENV}

help: ## Show this help
	$(eval HELP_COL_WIDTH:=13)
	@echo "Makefile targets:"
	@grep -E '[^\s]+:.*?## .*$$' ${MAKEFILE_LIST} | grep -v grep | envsubst | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-${HELP_COL_WIDTH}s\033[0m %s\n", $$1, $$2}'
