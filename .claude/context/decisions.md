# Decisiones

Las decisiones de arquitectura y sus alternativas descartadas están en `docs/decisions.md` (visibles para quien revise el repositorio). Este archivo solo lleva lo pendiente.

## Pendiente

- Emisor real de tokens de servicio (hoy llave local) y autenticación reciente para operaciones sensibles.
- Zona horaria por producto para cortes e intereses (hoy UTC).
- Servicio externo de condiciones del producto (hoy adaptador estático).
- Congelar tarjeta.
- Reducciones de cupo forzadas desde custodia (fraude, contracargos).
- Conciliación diaria de depósitos contra el estado de cuenta del banco.
- Rate limiting por aplicación, revocación de tokens, rol de operaciones.
- Aplicar Terraform en una cuenta real y añadir pipeline de CI/CD.
