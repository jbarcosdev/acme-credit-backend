# Mapa del proyecto

```
services/
  lending/      src/modules/{accounts,billing,limits}, src/clients/{custody,terms}, src/cli/daily-jobs.ts, prisma/, test/
  collateral/   src/modules/custody, src/clients/{banks,terms}, prisma/, test/
lib/
  contracts/    sobre de eventos, tipos de la API de custodia, scopes
  auth/         TokenVerifier (jose), ServiceTokenProvider, AuthGuard, AccessPolicy, CurrentUser
  cache/        Cache (compare-and-set por versión), Redis e in-memory
  messaging/    EventPublisher/EventConsumer, SNS, SQS, in-memory, config AWS
  nest-common/  CommonModule (validación, filtro de errores, CLS, access log), HealthModule, errores, dinero, reloj, idempotencia, auditoría, outbox
e2e/            prueba completa entre los dos servicios
docker/         service.Dockerfile (targets runtime y migrate), init de Postgres y LocalStack
terraform/      modules/{network,ecr,messaging,postgres,redis,alb,ecs-service,ecs-job}, environments/dev
scripts/        dev-setup, mint-token, simulate-bank-webhook, run-daily-jobs, demo, export-prompts
docs/           domains, flows, security, decisions
apps/           vacío
```

Tablas estándar en cada base (SQL crudo desde `lib/nest-common`): `idempotency_keys`, `audit_log`; collateral añade `outbox_events`.

Gotchas aprendidos:
- Las libs declaran `@nestjs/*`, `nestjs-cls` y `class-validator` como peerDependencies; con dependencias normales pnpm duplica instancias y la inyección falla.
- `.tsbuildinfo` debe quedar fuera del contexto de Docker (`.dockerignore`) o tsc incremental no emite `dist`.
- LocalStack `latest` exige token; se fija la 4.9.
- Prettier reformatea los archivos y rompe los reemplazos de texto exactos: editar con la herramienta Edit tras leer el archivo.
