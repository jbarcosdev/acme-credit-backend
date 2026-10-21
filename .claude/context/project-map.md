# Mapa del proyecto

Estado: monorepo pnpm inicializado, sin lógica de dominio.

```
services/
  lending/      accounts, billing, limits (src/modules), shared/, clients/, prisma/
  collateral/   custody (src/modules), shared/, clients/, prisma/
lib/
  contracts/    sobre de eventos y tipos de la API entre servicios
  messaging/    puertos de eventos, adaptadores SNS/SQS y en memoria
  auth/         TokenVerifier, AccessPolicy, CurrentUser
  cache/        puerto de caché, adaptadores Redis y en memoria
  nest-common/  HealthModule (GET /health)
apps/           vacío
terraform/      vacío (README)
docs/           domains.md, flows.md, security.md
docker/postgres/init.sql   crea las bases lending y collateral con un usuario cada una
docker-compose.yml         Postgres y Redis
```

Las libs `contracts`, `messaging`, `auth` y `cache` son placeholders vacíos. Cada servicio tiene Prisma 7 configurado (`prisma.config.ts`, `prisma/schema.prisma` sin modelos) y `/health` con e2e.

## Pendiente de implementar

- Puertos y adaptadores en `lib/` y `src/clients/` de cada servicio.
- Modelos Prisma y migraciones (incluyendo `CHECK` y el trigger que hace inmutable el diario).
- Outbox, idempotencia y auditoría en `src/shared/` (pensar si algo de esto va a `lib/nest-common`).
- LocalStack en `docker-compose.yml`.
- Dockerfiles por servicio (`pnpm deploy --filter`) y Terraform.
