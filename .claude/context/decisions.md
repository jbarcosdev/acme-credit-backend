# Decisiones

Las decisiones de arquitectura y sus alternativas descartadas están en `docs/decisions.md` (visibles para quien revise el repositorio). Este archivo solo lleva lo pendiente.

## Pendiente

- Compras diferidas a cuotas (fase 2): planes de cuotas en billing, cuotas en el estado de cuenta y en el pago mínimo, reclasificación de `DEFERRED` a capital en cada corte, vencimiento anticipado al cerrar.
- Esquema HMAC para bancos que no firmen con llave asimétrica.
- Emisor real de tokens de servicio (hoy llave local) y autenticación reciente para operaciones sensibles.
- Zona horaria por producto para cortes e intereses (hoy UTC).
- Servicio externo de condiciones del producto (hoy adaptador estático).
- Congelar tarjeta.
- Reducciones de cupo forzadas desde custodia (fraude, contracargos).
- Conciliación diaria de depósitos contra el estado de cuenta del banco.
- Rate limiting por aplicación, revocación de tokens, rol de operaciones.
- Aplicar Terraform en una cuenta real y añadir pipeline de CI/CD.
