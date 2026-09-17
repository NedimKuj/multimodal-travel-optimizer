# AGENTS.md

## Project

This repository implements a multimodal travel optimizer.

The core product is the optimizer, not the UI.

The system must optimize complete trips across:
- flights
- trains
- buses
- alternative airports
- open-jaw routes
- multi-city routes
- accommodation

## Source of Truth

The implementation plan is located at:

`docs/implementation-plan.md`

Read it before implementing significant features.

## Core Engineering Rules

### 1. Correctness over appearance

Do not implement fake functionality.

Never:
- fabricate prices
- fabricate availability
- hardcode production itineraries
- label cached data as live
- silently substitute mock data
- claim unsupported provider capabilities

A smaller correct implementation is preferable to a larger inaccurate implementation.

### 2. Provider isolation

All external providers must be accessed through provider adapters.

Provider-specific types must never leak into the domain or optimizer packages.

External responses must be validated at the boundary.

### 3. Deterministic optimization

The optimizer must be deterministic.

Never use an LLM to decide:
- route feasibility
- connection validity
- price comparisons
- budget compliance
- itinerary construction
- candidate pruning

AI may later be used for natural-language input and explanations.

### 4. Open-jaw is first-class

Open-jaw routes are part of the core domain.

The optimizer must support:

SJJ → A
B → SJJ

and:

SJJ → A → B → SJJ

Do not implement open-jaw as a special case around a round-trip implementation.

### 5. Complete-trip cost

Optimize total trip cost, not ticket price.

Include:
- flights
- trains
- buses
- ground transfers
- accommodation
- currency conversion

### 6. Feasibility

Never return a route that cannot physically be completed.

Validate:
- connection times
- airport changes
- station changes
- timezone differences
- overnight journeys
- accommodation dates
- date boundaries

### 7. User constraints

Never silently relax constraints.

If no exact matches exist, explicitly label near-matches as such.

### 8. API economics

Treat external API calls as expensive.

Before calling a provider:
1. check cache
2. deduplicate
3. filter locally
4. prune candidates
5. call the provider

Do not perform uncontrolled nested API searches.

### 9. Data provenance

Every external price must retain:

- provider
- source type
- fetchedAt
- expiresAt
- currency
- provider identifier

Use:

`cached | recent | live | estimated`

accurately.

### 10. Money

Never use floating point for monetary calculations.

Use integer minor units or Decimal.

All money values must include their currency.

### 11. Time

Transport timestamps must preserve timezone information.

Never use naive timestamps for flights or trains.

### 12. TypeScript

Use strict TypeScript.

Avoid:
- `any`
- `@ts-ignore`
- unsafe casts

Validate external data with Zod.

### 13. Testing

Every optimizer rule requires tests.

Every optimizer bug requires a regression test.

Before completing a task, run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

### 14. Partial provider failures

One provider failing must not necessarily fail the entire search.

Return valid partial results when possible and expose provider failures through structured metadata.

### 15. Reproducibility

Every search must have a `searchId`.

Record:
- normalized request
- optimizer version
- provider information
- timestamps
- candidate counts
- final results

### 16. Avoid premature architecture

Do not introduce:
- microservices
- Kafka
- Kubernetes
- CQRS
- event sourcing
- GraphQL
- Elasticsearch
- ML ranking
- vector databases

unless there is a demonstrated requirement.

Prefer the existing modular-monolith architecture.

## Definition of Done

A task is not complete merely because the code compiles.

It is complete when:
- implementation matches the domain model
- tests cover the behavior
- external data is validated
- provider provenance is preserved
- no fake data is introduced
- typecheck passes
- lint passes
- tests pass
- build passes

When requirements are ambiguous, inspect the implementation plan and existing architecture before inventing new behavior.

## Git & Commit Discipline

This repository uses Git. Git history is part of the project's engineering quality.

### Atomic commits

Make **small, atomic commits**.

Each commit should represent one coherent change that can be understood, reviewed, reverted, or cherry-picked independently.

Prefer:

```text
Add Money domain type
Add Aviasales response schema
Implement flight offer normalization
Add open-jaw candidate generator
Add connection validation tests
Add Redis search cache
```

Avoid combining unrelated changes:

```text
Implement optimizer, UI, database, providers, and tests
```

If a feature naturally consists of multiple independent steps, create multiple commits.

For example:

```text
Add transport domain models
Add flight provider interface
Add Aviasales adapter
Add flight normalization tests
```

### Commit message format

Commit messages must be:

- one line
- imperative
- concise
- descriptive
- written in English

Use the imperative mood:

```text
Add flight provider interface
Implement open-jaw candidate generation
Fix timezone handling for overnight flights
Refactor candidate pruning
Add tests for airport transfers
Update Aviasales response schema
```

Do not use past tense:

```text
Added flight provider interface
Implemented open-jaw generation
Fixed timezone handling
```

Do not use vague messages:

```text
Update stuff
Changes
Fix things
WIP
Various improvements
Final changes
```

### Commit message style

Use a simple imperative sentence without unnecessary prefixes.

Preferred:

```text
Add open-jaw route generation
```

Also acceptable when a scope genuinely improves clarity:

```text
optimizer: Add open-jaw route generation
providers: Normalize Aviasales flight offers
web: Add trip search form
```

Do not add ticket numbers, usernames, model names, tool names, or other metadata unless the repository explicitly requires them.

### No AI attribution

Never mention an AI tool, coding agent, model, assistant, or automated system as a co-author or contributor.

Do not add:

```text
Co-authored-by: ChatGPT
Co-authored-by: Claude
Co-authored-by: GitHub Copilot
Generated by AI
Generated by Claude Code
Created with ChatGPT
```

Do not add AI-related trailers, signatures, or attribution to commit messages.

The Git history should describe the **software change**, not which tool helped produce it.

### Commit before moving on

When a coherent implementation milestone is complete and verified, commit it before starting an unrelated change.

For example:

```text
Implement Money value object
```

then, after verification:

```text
Add Money unit tests
```

rather than accumulating a large uncommitted set of unrelated changes.

### Never commit broken work as completed work

Before creating a commit, run the relevant checks.

At minimum, for code changes:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Run:

```bash
pnpm build
```

when the change affects the application build or when completing a larger milestone.

Do not create a commit that knowingly leaves the repository in a broken state unless the commit is explicitly a work-in-progress commit requested by the user.

### Inspect the diff before committing

Before every commit:

```bash
git status
git diff
```

Confirm that:

- only intended files are included
- no secrets are included
- no credentials or API tokens are included
- no generated artifacts are accidentally committed
- no unrelated formatting changes are included
- the commit represents one coherent change

Prefer staging specific files or hunks when appropriate:

```bash
git add packages/domain/money.ts packages/domain/money.test.ts
```

rather than blindly staging the entire repository.

Be especially careful with:

```bash
git add .
```

and never use it without first inspecting the working tree.

### Never commit secrets

Never commit:

- API keys
- access tokens
- passwords
- private keys
- `.env` files containing secrets
- provider credentials
- database credentials

Use environment variables and `.env.example` files containing placeholder values.

Before committing provider integrations, verify that credentials have not accidentally entered source files, logs, fixtures, or configuration.

### Do not rewrite history unnecessarily

Do not use:

```bash
git reset --hard
git clean -fd
git rebase
git commit --amend
git push --force
```

unless explicitly requested or clearly necessary for the task.

Never discard user changes simply to make the working tree cleaner.

If unrelated user changes are present, preserve them.

### Preserve user work

Before modifying files, inspect the working tree:

```bash
git status
```

If there are existing uncommitted changes, determine whether they belong to the current task.

Do not overwrite, revert, reset, or delete changes that were already present.

If it is unclear whether an existing change belongs to the task, stop and inspect before modifying it.

### Branches

Do not create, rename, delete, or switch branches unless explicitly requested.

Work on the currently checked-out branch by default.

### Example development sequence

A typical implementation might look like:

```text
1. Inspect repository
2. Implement domain Money type
3. Run tests
4. Commit:
   Add Money domain type

5. Add provider interface
6. Run tests
7. Commit:
   Add flight provider interface

8. Implement Aviasales normalization
9. Add normalization tests
10. Run checks
11. Commit:
    Implement Aviasales flight normalization

12. Implement open-jaw generation
13. Add optimizer tests
14. Run checks
15. Commit:
    Add open-jaw candidate generation
```

The goal is a Git history that tells the story of the implementation clearly.

### Commit quality test

Before committing, ask:

> Can this commit be described accurately in one short imperative sentence?

If not, the change may contain too many unrelated changes and should probably be split.

## Project Documentation

Before making implementation decisions, read the relevant project documentation.

At minimum, read:

- `docs/implementation-plan.md` — project roadmap and implementation phases
- `docs/optimizer-spec.md` — authoritative optimizer behavior and domain rules
- `docs/provider-compliance.md` — provider usage, licensing, caching, and commercial constraints

When working on an architectural decision, also inspect:

- `docs/decisions/` — accepted architectural decisions and their rationale

Do not assume these documents are exhaustive. Inspect the repository structure and existing code before starting work.

If documentation conflicts with the current code:
- determine whether the code or documentation represents the newer intended behavior
- do not silently choose when the conflict materially affects architecture or product behavior
- document or ask for clarification when necessary