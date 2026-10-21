# Decisiones de diseño

Registro cronológico. Cada entrada: contexto, opciones consideradas, decisión, trade-offs.

## Decisiones tomadas

- Stack: NestJS (TypeScript). Directiva del usuario.
- Arquitectura: microservicios. Directiva del usuario; falta definir los límites de servicio y justificarlos.
- Contenedores: Docker. Despliegue tentativo en ECS con Fargate por simplicidad operativa (sin gestionar nodos).
- Repos: por ahora estructura de repos separados; el monorepo se evalúa al agregar la IaC.
- Estructura interna: módulos Nest por subdominio en `src/modules/`. Subdominios del scaffold (provisionales, a validar en el diseño): collateral, cards, authorizations, repayments, ledger, health.
- Base de datos: PostgreSQL en Docker (`docker-compose.yml`).
- Simulación de AWS en local: LocalStack (especificado, configuración pendiente).
- ORM: Prisma (esquema como fuente única, tipos generados, `bigint` nativo, migraciones SQL editables). Bloqueos de fila, `CHECK` y triggers del diario se escriben en SQL dentro de las migraciones y con `$queryRaw`. Se descartó TypeORM. Verificar temprano la configuración con ESM y Nest 12.
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

## Decisiones de dominio (propuestas, pendientes de aprobación final)

Ver `docs/domains.md` y `docs/flows.md`.

- Dos servicios, `collateral-service` (custody) y `lending-service` (accounts, billing, limits), con bases de datos separadas.
- Lending consulta y ordena a custodia por HTTP (idempotente, con job de reintento y estado `CLOSING`). Custodia avisa los cambios de cupo por evento.
- Mensajería: SNS más SQS (con DLQ) por seguridad (IAM, sin endpoints expuestos), fan-out a varios consumidores y operación mínima. Se descartaron API destination de EventBridge (exposición y autenticación débil), Lambda (otro artefacto y cableado en VPC), RabbitMQ (operación y costo en AWS) y EventBridge como bus (sin necesidad hoy, el consumidor no cambia si se adopta después).
- Custodia publica con outbox transaccional, porque publicar en SNS es una escritura aparte de la base de datos.
- Redis compartido para el cupo (no negociable: la caché debe sobrevivir a la caída de una tarea). Se escribe con compare-and-set por versión; un dato ausente significa consultar a custodia. TTL de 12 h como red de seguridad.
- El evento solo es una señal (`accountId` y `version`); lending vuelve a consultar el cupo. Un duplicado o desorden no corrompe nada.
- Ack del mensaje solo después de escribir en Redis.
- Puertos y adaptadores en `src/clients/` (`messaging`, `cache`, `custody`), con contrato neutral al proveedor y adaptadores en memoria para tests. Se evita envolver Postgres o Prisma (YAGNI).
- El ratio colateral a cupo vive en custodia; lending solo ve el cupo.
- La tarjeta se crea cuando el cliente la solicita y custodia informa cupo mayor a cero, sin evento de activación.
- Política ante falla de custodia configurable por entorno (`deny` o `use_stale`, con edad máxima); por defecto `deny`.
- Reducciones de cupo: lending guarda un tope propio en Postgres dentro de la transacción de validación, ordena a custodia, escribe el valor nuevo en Redis y retira el tope.
- Identidad: se asume un proveedor de identidad externo (Clerk u otro) que emite JWT firmados; el servicio solo los valida (`TokenVerifier`, adaptador con llave pública o JWKS). Sin dependencia de un proveedor concreto.
- Autorización: puerto `AccessPolicy` con adaptador local (`ownerId` más scopes). Cada servicio autoriza por su cuenta; sin servicio de autorización central en este alcance. Ver `docs/security.md`.
- `CurrentUser` se construye desde las claims y se pasa explícito a los casos de uso; `nestjs-cls` solo para auditoría. `ownerId` (el `sub`) en cuentas de tarjeta y de custodia, con 404 si no coincide.
- Confirmación de depósitos: webhook de cada banco a custodia (`POST /webhooks/banks/:bankId`), con firma asimétrica preferida (llave pública por banco con `kid`) o HMAC con marca de tiempo si el banco solo soporta secreto compartido, referencia impredecible por depósito, idempotencia por banco e id de evento y validación contra el depósito `PENDING`. Verificar al origen antes de acreditar. Único endpoint público.
- Varios bancos: puerto `BankAdapter` en `src/clients/banks` con un adaptador por banco (capa anticorrupción que normaliza el evento y consulta el estado del depósito) y un registro por `bankId`. Hoy solo el banco simulado. Se reemplaza así la decisión previa de omitir el gateway bancario.
- Estados de la tarjeta: ACTIVE, DELINQUENT, CLOSING, CLOSED. Congelar tarjeta queda en el backlog.
- Billing es un módulo de lending, no un servicio: comparte la frontera de consistencia con el diario (atomicidad con saldos y autorizaciones, foto determinista en el corte). Se comunica con `accounts` solo por su interfaz pública para poder extraerlo. Opción futura: ejecutarlo como tarea programada aparte con la misma imagen y base de datos.
- Día de corte 1 o 15, elegido por el cliente al solicitar la tarjeta; el perfil de facturación vive en billing. Cambiar el día de corte queda fuera de alcance (evita prorrateos).
- Condiciones del producto (tasas, cargos, mínimo, mora, `cycleDays`, ratio, zona horaria) vienen de un servicio externo detrás del puerto `ProductTermsProvider`, hoy con un adaptador estático. No se crea servicio falso. Las condiciones son versionadas e inmutables, la cuenta guarda su `termsVersion` y cada estado de cuenta guarda copia de lo aplicado.

## Backlog de decisiones pendientes

A cerrar cuando estén definidos los dominios y los flujos principales.

Parámetros de negocio (valores iniciales propuestos, configurables):
- Ratio colateral a cupo, vive en custodia (propuesto 90%, deja colchón para intereses y cargos).
- Tasa anual de interés (propuesto 36%).
- Cargo fijo por mora.
- Pago mínimo: porcentaje y piso.
- Días de mora para cierre automático y aplicación del colateral (propuesto 90).

Reglas de billing:
- Compras diferidas a cuotas (fase 2, dejando el modelo preparado: bucket `DEFERRED`, `installments` y `rateBps` en el movimiento de compra, opciones de cuotas en las condiciones): planes de cuotas en billing, cuotas vencidas en el estado de cuenta y en el pago mínimo, compra completa como deuda desde el inicio y bucket de capital separado en revolvente y diferido.
- Servicio externo de condiciones del producto: adaptador HTTP con caché cuando exista.
- Período de gracia: propuesto no tenerlo.
- Intereses: propuesto saldo diario promedio de capital, calculado al corte, sin interés sobre interés.
- Pagos mayores a la deuda: propuesto rechazarlos (sin saldos a favor).
- Reversos posteriores al corte: ajustan el siguiente ciclo, nunca un estado de cuenta emitido.
- Cascada de pagos: cargos, intereses, capital.

Límite de cupo (LimitSource):
- El cupo es un indicador; el disponible es cupo menos deuda. Valores iniciales de TTL, timeout y edad máxima en `docs/domains.md`.
- Retraso de aplicación de aumentos de cupo como regla de producto (hoy el aumento se aplica en cuanto llega el evento).
- Reducciones de cupo forzadas por operaciones desde custodia (hoy solo las inicia lending).
- Congelar tarjeta.
- La consulta de cupo ocurre antes de abrir la transacción, nunca con la fila bloqueada.
- Estrategia de expulsión de Redis para que no saque cupos antes de su TTL, y alarmas de DLQ y de antigüedad de la cola.

Seguridad:
- Conciliación diaria de depósitos contra el estado de cuenta del banco.
- Cómo se emiten y validan los tokens de servicio entre lending, custodia, la red de tarjetas y el banco (mismo proveedor u otro emisor).
- Autenticación reciente (`auth_time`) para operaciones sensibles.
- Rol de operaciones, limitación de tasa (rate limiting) y revocación de tokens.

Calidad:
- Test de propiedad: el saldo materializado coincide siempre con la suma del diario.
- Reloj inyectable para pruebas de billing.
- Ejecución de jobs (corte, mora): EventBridge Scheduler en AWS, comando o endpoint administrativo en local; idempotentes por claves únicas.
