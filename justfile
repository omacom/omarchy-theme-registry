# Local CI and registry chores. Run `just` to list them.
# Anything that talks to GitHub wants GITHUB_TOKEN; `gh auth token` is the easy source.
alias c := check
alias t := test

set shell := ["bash", "-euo", "pipefail", "-c"]
set dotenv-load
export GITHUB_TOKEN := env("GITHUB_TOKEN", `gh auth token 2>/dev/null || true`)

default:
    @just --list

install:
    pnpm install --frozen-lockfile

lint:
    pnpm lint

# Rewrite files with prettier
format:
    pnpm format

# What ci.yml runs: formatting + eslint, type-check, unit tests
check: format lint
    pnpm check
    pnpm test

test *args:
    pnpm test {{ args }}

# Validate a repo URL or a registry slug the way the catalog build does
validate target:
    node scripts/validate.ts {{ target }}

# Validate entries changed vs origin/master (what validate-pr.yml does)
validate-changed:
    node scripts/validate.ts --changed

# Dry-run a submission: what the issue workflow would produce for this repo (add --write to create the entry)
submit repo login *args:
    node scripts/submit.ts --repo {{ repo }} --submitted-by {{ login }} {{ args }}

# Full catalog build into dist/v1 (clones every repo; cached in .work/)
build:
    pnpm build

# What upload.ts would send to R2 (needs the R2_* variables from .env)
upload-dry:
    node scripts/upload.ts --dry-run

upload:
    node scripts/upload.ts
