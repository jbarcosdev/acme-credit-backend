# Decisiones de diseño

Registro cronológico. Cada entrada: contexto, opciones consideradas, decisión, trade-offs.

## Decisiones tomadas

- Stack: NestJS (TypeScript). Directiva del usuario.
- Arquitectura: microservicios. Directiva del usuario; falta definir los límites de servicio y justificarlos.
- Contenedores: Docker. Despliegue tentativo en ECS con Fargate por simplicidad operativa (sin gestionar nodos).
- Package manager: yarn 4 con node-modules en vez de PnP, para compatibilidad con Docker e IDE.

## Pendientes de decidir

- Límites de los microservicios y comunicación entre ellos (HTTP, mensajería, eventos). Decidir si es monorepo Nest (`apps/` y `libs/`) o repos separados.
- Persistencia (en memoria, SQLite o PostgreSQL en contenedor) y control de concurrencia (locks pesimistas, versionado optimista, serialización por cuenta).
- Modelo de dinero y ledger de doble entrada.
- Idempotencia, outbox/eventos y auditoría.
- Autenticación/autorización simulada y manejo de secretos.
- Alcance extra: intereses, estados de cuenta, mora, congelamiento de tarjeta, aumentos de límite.
- IaC (Terraform/AWS) y estrategia de despliegue.
- Estrategia de pruebas.
