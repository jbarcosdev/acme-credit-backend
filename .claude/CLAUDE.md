# lending-service

Servicio de lending para Acme Credit (tarjeta de crédito asegurada con colateral). Reto técnico con entrega en 5 días. Especificación completa en @.claude/context/spec.md.

## Fase actual

Diseño, con el proyecto NestJS inicializado (sin lógica de dominio). Las decisiones se registran en `.claude/context/decisions.md` antes de implementar.

## Working rules

- Reply in Spanish.
- For opinions, feedback or design questions answer in prose only. Write code only after an explicit "procede" or "proceed".
- No code comments unless asked. No em dash in text. Avoid unnecessary line breaks.
- YAGNI and KISS: do not saturate classes with fields, methods or helpers that are not needed.
- Be concise. Do not overcomplicate designs.
- Deliver only new or modified files with their exact destination path, never a zip.
- Every architectural choice must record its trade-offs in `decisions.md` (the challenge evaluates the thinking process).
- Every AI prompt and response used in the build must be kept in `PROMPTS.md` (challenge requirement). Update it at the end of each working session.

## Invariantes del dominio (no negociables)

- Dinero: enteros en la unidad menor (centavos) o decimal exacto, nunca float. Una sola moneda por cuenta.
- Una compra nunca excede el crédito disponible, incluso con concurrencia.
- Toda operación que mueve dinero es idempotente (idempotency key) y deja registro de auditoría inmutable.
- La tarjeta solo se activa con colateral confirmado; el límite se deriva del depósito.
- Ledger de doble entrada como fuente de verdad de los saldos.

## Stack (directivas del usuario)

- NestJS 12, TypeScript, Node 22 (`.nvmrc`), yarn 4 con `nodeLinker: node-modules` (el CLI genera PnP por defecto; se descartó por fricción con Docker e IDE).
- Arquitectura de microservicios, Docker, despliegue tentativo en ECS con Fargate.
- Seguir las prácticas estándar de NestJS (módulos, DI, DTOs con validación, config, tests).
- Tooling que trae el scaffold: vitest (unit y e2e), oxlint, prettier.

## Commands

- Instalar: `yarn install`
- Build: `yarn build`
- Dev: `yarn start:dev`
- Tests: `yarn test`, `yarn test:e2e`, `yarn test:cov`
- Lint: `yarn lint`

## Arquitectura

Por definir. Ver `decisions.md` y `project-map.md`.
