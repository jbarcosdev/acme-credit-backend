# PROMPTS

Registro en orden de los prompts y respuestas de IA usados en la construcción (requisito del reto).

## Sesión 1: inicialización de la estructura

Prompt: revisar las especificaciones y crear la estructura base del proyecto (`.claude`) similar a la de openloops, sin construir nada aún.
Respuesta: se creó `.claude/` con CLAUDE.md, CLAUDE.local.md, settings.local.json y context/ (spec, decisions, project-map), más este archivo.

## Sesión 1: directivas de diseño e inicialización de NestJS

Prompt: usar NestJS, arquitectura de microservicios, Docker, despliegue tentativo en ECS con Fargate, prácticas estándar de NestJS; empezar inicializando un proyecto NestJS.
Respuesta: se generó el scaffold con `@nestjs/cli new` (yarn, strict), cambiando a `nodeLinker: node-modules`; se agregaron `.nvmrc` y `.gitignore`; build, tests y lint pasan; se actualizaron CLAUDE.md, decisions.md y project-map.md.

## Sesión 1: scaffold limpio por módulos, Postgres y LocalStack

Prompt: mantener estructura de repos separados; scaffold limpio con módulos y subdominios en carpetas independientes; Postgres en Docker; agregar LocalStack a las especificaciones sin configurarlo; luego proceder con el diseño.
Respuesta: se eliminaron controller y service de ejemplo, se crearon módulos vacíos por subdominio y un módulo health, se agregó docker-compose con Postgres y `.env.example`, y se actualizaron CLAUDE.md, decisions.md y project-map.md. Build, e2e y compose validados.

## Sesión 1: modelo de dominio y límite de cupo

Prompt: discusión de uno vs varios servicios; modelo de tarjeta respaldada con custodia separada; intereses, estados de cuenta y mora; límite de cupo consultado en tiempo real con caché; pendientes al backlog.
Respuesta: se discutió la división en `collateral-service` y `lending-service`, se propuso el diario con buckets y el billing, y se registró el backlog de decisiones en decisions.md.

## Sesión 1: documentación de dominios y flujos

Prompt: política configurable ante falla de la consulta del cupo; mostrar cómo quedan los dominios y hacer gráficos básicos de los flujos para la documentación.
Respuesta: se crearon docs/domains.md y docs/flows.md con diagramas Mermaid y se actualizó decisions.md con las decisiones propuestas.

## Sesión 1: mensajería, Redis y puertos

Prompt: Redis compartido; evaluar EventBridge, API destination, Lambda, SQS, SNS, RabbitMQ; elegir SNS y SQS con clientes desacoplados por puertos (inspirado en `clients` de openloops); definir cómo quedan los dominios.
Respuesta: se comparó cada opción, se adoptó SNS y SQS con outbox en custodia, Redis con compare-and-set por versión y puertos en `src/clients/`, y se reescribieron docs/domains.md, docs/flows.md y decisions.md.

## Sesión 1: facturación y condiciones del producto

Prompt: fecha de corte (1 o 15, elegida por el usuario), parámetros desde un servicio externo con valores estáticos, diferidos, y si billing va dentro de lending.
Respuesta: billing se mantiene como módulo de lending con frontera estricta; puerto ProductTermsProvider con adaptador estático y condiciones versionadas; diferidos y cambio de día de corte al backlog; docs actualizados.

## Sesión 1: identidad y autorización

Prompt: cómo manejar la autorización con ownerId y CurrentUser; identidad mockeada pero real en la práctica, sin Cognito; el token firmado es de confianza; asumir solo que existe un proveedor.
Respuesta: se documentó docs/security.md con TokenVerifier, AccessPolicy, ownerId, scopes de servicio y control por repositorio, y se actualizó decisions.md.

## Sesión 1: webhooks y varios bancos

Prompt: el banco puede firmar con llave privada y nosotros guardar la pública, o enviar un token; debe soportar múltiples bancos.
Respuesta: firma asimétrica preferida y HMAC como alternativa, referencia impredecible por depósito, puerto BankAdapter con registro por bankId; docs de seguridad y dominios actualizados.
