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
