.PHONY: help dev test lint format migrate up down worker

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install the project in development mode
	pip install -e ".[dev]"

init-submodule: ## Initialize git submodules
	git submodule update --init --recursive

dev-api: ## Run the internal API locally
	uvicorn api.main:app --reload --port 8000

dev-bff: ## Run the BFF + shell locally
	uvicorn bff.main:app --reload --port 8080

test: ## Run all tests
	python -m pytest tests/ -v

lint: ## Run ruff linter
	ruff check shared/ api/ bff/ workers/ scripts/ tests/

format: ## Run ruff formatter
	ruff format shared/ api/ bff/ workers/ scripts/ tests/

migrate: ## Run database migrations (sql/)
	python -m scripts.migrate

up: ## Start the full stack (db + keycloak + migrate + api + bff)
	docker compose up -d db keycloak migrate api bff

up-all: ## Start the full stack including workers
	docker compose --profile worker up -d

down: ## Stop the Docker Compose stack
	docker compose down

worker: ## Run all workers locally
	python -m workers.run_all

update-submodule: ## Update the ProjectJLMirror submodule to latest
	git submodule update --remote vendor/ProjectJLMirror
