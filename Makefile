.PHONY: help dev test test-unit lint format migrate up down worker

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

dev: ## Run the API in development mode (hot reload)
	uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

test: ## Run all tests
	python -m pytest tests/ -v

test-unit: ## Run unit tests only
	python -m pytest tests/ -v -k "not integration"

lint: ## Run ruff linter
	ruff check app/ scripts/ tests/

format: ## Run ruff formatter
	ruff format app/ scripts/ tests/

migrate: ## Run database migrations
	python -m scripts.migrate

up: ## Start the full stack with Docker Compose
	docker compose up -d db api

up-all: ## Start the full stack including workers and migrations
	docker compose --profile migrate --profile worker up -d

down: ## Stop the Docker Compose stack
	docker compose down

worker: ## Run all workers locally
	python -m app.workers.run_all

install: ## Install the project in development mode
	pip install -e ".[dev]"

init-submodule: ## Initialize git submodules
	git submodule update --init --recursive

update-submodule: ## Update the ProjectJLMirror submodule to latest
	git submodule update --remote vendor/ProjectJLMirror
