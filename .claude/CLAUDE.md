# acme-credit-backend

Servicio de lending para Acme Credit (tarjeta de crédito asegurada con colateral). Reto técnico con entrega en 5 días. Especificación completa en @.claude/context/spec.md.

## Fase actual

Implementación completa de la primera versión (ver README y `docs/`). Las decisiones de diseño viven en `docs/decisions.md`; lo pendiente, en `.claude/context/decisions.md`.

## Working rules

- Reply in Spanish.
- For opinions, feedback or design questions answer in prose only. Write code only after an explicit "procede" or "proceed".
- No code comments unless asked. No em dash in text. Avoid unnecessary line breaks.
- YAGNI and KISS: do not saturate classes with fields, methods or helpers that are not needed.
- Be concise. Do not overcomplicate designs.
- Deliver only new or modified files with their exact destination path, never a zip.
- Every architectural choice must record its trade-offs in `decisions.md` (the challenge evaluates the thinking process).
- Commits: no `Co-Authored-By` trailer or any Claude/AI attribution in commit messages or PR descriptions. The only author is the user.
- Commit as often as it makes sense during implementation.
- `PROMPTS.md` (challenge requirement) is generated from the session transcript with `pnpm prompts:export`. Re-run it at the end of each working session, never edit it by hand.

## Invariantes del dominio (no negociables)

- Dinero: enteros en la unidad menor (centavos) o decimal exacto, nunca float. Una sola moneda por cuenta.
- Una compra nunca excede el crédito disponible, incluso con concurrencia.
- Toda operación que mueve dinero es idempotente (idempotency key) y deja registro de auditoría inmutable.
- La tarjeta solo se activa con colateral confirmado; el límite se deriva del depósito.
- Ledger de doble entrada como fuente de verdad de los saldos.

## Stack (directivas del usuario)

- Monorepo pnpm (10.x, versión fijada en `packageManager`) con NestJS 12, TypeScript, Node 22 (`.nvmrc`). Sin Turborepo ni Taskfile por ahora (YAGNI): `pnpm -r` ordena los builds por dependencias.
- Microservicios, Docker, despliegue tentativo en ECS con Fargate. IaC con Terraform.
- Seguir las prácticas estándar de NestJS (módulos, DI, DTOs con validación, config, tests).
- Prisma 7 con un esquema, migraciones y cliente generado por servicio (no global: cada servicio tiene su base de datos). El cliente se genera en `src/generated/prisma` (ignorado por git) durante el build.
- PostgreSQL en Docker para local (dos bases, un usuario por base) y Redis. LocalStack (SNS, SQS) especificado, aún sin configurar.
- Tooling: vitest (unit y e2e), oxlint, prettier. Imports ESM con extensión `.js`.
- Sin comentarios en el código, salvo petición.

## Estructura

- `services/lending` y `services/collateral`: un módulo Nest por subdominio en `src/modules/<subdominio>/`; `src/shared/` para código transversal del servicio; `src/clients/` para clientes propios del servicio (custody y terms en lending, banks en collateral).
- `lib/`: infraestructura técnica compartida, sin lógica de dominio. `contracts` (único acoplamiento deliberado entre servicios), `messaging`, `auth`, `cache`, `nest-common` (health).
- `apps/`: aplicaciones web futuras. `terraform/`: IaC (módulos y entorno dev, validada, no aplicada). `docs/`: diseño. `docker/`: Dockerfile de servicios y scripts de inicio. `e2e/`: prueba entre servicios. `scripts/`: herramientas de desarrollo.

## Commands

- Instalar: `pnpm install`
- Infra local: `pnpm infra:up` (Postgres, Redis, LocalStack 4.9 con SNS/SQS), `pnpm infra:down`
- Claves y .env de desarrollo: `pnpm dev:setup`
- Build (libs, luego `prisma generate` y `nest build` por servicio): `pnpm build`
- Dev: `pnpm dev:lending`, `pnpm dev:collateral`
- Todo en contenedores: `pnpm apps:up`, `pnpm demo`, `pnpm apps:down`
- Tests: `pnpm test`, `pnpm test:e2e` (requieren `pnpm infra:up` y `pnpm build` previo); todo junto: `pnpm check`
- Lint y formato: `pnpm lint`, `pnpm format`
- Migraciones de un servicio: `pnpm --filter @acme/lending prisma:migrate` (crea) o `prisma:migrate:deploy` (aplica)
- Helpers: `pnpm token`, `pnpm bank:confirm`, `pnpm jobs:daily`, `pnpm prompts:export`

## Arquitectura

Dos servicios (`lending`, `collateral`), cada uno con su base de datos. Ver `docs/decisions.md`, `docs/domains.md`, `docs/flows.md` y `.claude/context/project-map.md`.
