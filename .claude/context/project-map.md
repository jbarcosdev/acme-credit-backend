# Mapa del proyecto

Estado: scaffold NestJS limpio, sin lógica de dominio.

- `src/app.module.ts`: importa los módulos de subdominio.
- `src/modules/{collateral,cards,authorizations,repayments,ledger}/`: módulos vacíos, uno por subdominio.
- `src/modules/health/`: `GET /health` (para el healthcheck de ECS).
- `src/shared/`: código transversal (vacío).
- `test/app.e2e-spec.ts`: e2e de `/health`.
- `docker-compose.yml` y `.env.example`: PostgreSQL local. Actualizar este archivo cuando se cree la estructura real.

## Estructura prevista (a confirmar en diseño)

- `docs/`: arquitectura, decisiones (ADRs), modelo de datos, estrategia de concurrencia, seguridad, despliegue en cloud.
- `src/`: servicio.
- `tests/`: unitarios, integración, concurrencia, propiedades.
- `infra/`: IaC y contenedores para correr en local.
- `PROMPTS.md`: registro de prompts y respuestas de IA (requisito del reto).
- `README.md`: cómo correr, resumen de arquitectura y proceso de pensamiento.
