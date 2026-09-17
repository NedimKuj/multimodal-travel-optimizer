# 0001 — Workspace layout and toolchain

- Status: Accepted
- Date: 2026-09-17

## Context

`docs/implementation-plan.md` §7 recommends a monorepo with `apps/web`,
several `packages/*`, `services/*`, Prisma, Redis and BullMQ. `AGENTS.md` rule 16
forbids premature architecture, and the first milestone is the domain model.

## Decision

- **pnpm workspace** modular monolith. Packages are created only when they
  contain real code. The first package is `packages/domain`.
  `optimizer`, `providers`, `geo`, a CLI and `apps/web` are added in the
  milestones that need them.
- No Next.js, Prisma/PostgreSQL, Redis, BullMQ or `services/` yet.
- **Node >= 26**, ESM only.
- **TypeScript 6.0.3**, pinned exactly. TypeScript 7.x is the current `latest`
  release, but `typescript-eslint` 8.70 declares `typescript >=4.8.4 <6.1.0`,
  and type-aware linting is required. Revisit when typescript-eslint supports 7.
- Strict compiler settings: `strict`, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `nodenext` modules.
- **ESLint** with `typescript-eslint` `strictTypeChecked`. `any`, `@ts-ignore`,
  non-null assertions and type assertions (except `as const`) are errors.
- **Vitest** for tests, colocated as `*.test.ts`.
- **Zod 4** for validating data at boundaries.

Root scripts: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.

## Consequences

- Branded domain types are created through validating constructors or Zod
  schemas, never through casts.
- Package `build` emits `dist/` with declarations. Test files are excluded from
  the build but included in typecheck and lint.
