# Guía para agentes: levantar la plataforma y probarla de punta a punta

Esta guía es para un agente (o una persona) que quiere levantar Acme Credit en local, ejecutar los casos de uso básicos y comprobar que recibe lo esperado. Todo es reproducible con comandos; no hace falta leer el código.

## El sistema en cuatro líneas

- **collateral** (`http://localhost:3001`): guarda el dinero que el cliente deposita como garantía y calcula el cupo (90 % de lo retenido).
- **lending** (`http://localhost:3000`): tarjeta de crédito. Autoriza compras contra el cupo, cobra intereses, emite estados de cuenta, cobra mora y cierra la cuenta aplicando el colateral.
- Los montos son **enteros en centavos** (`100000` = 1000.00). Las tasas van en puntos básicos.
- Todo lo que mueve dinero exige el encabezado `Idempotency-Key` (cualquier cadena única por operación).

## 1. Levantar

Requisitos: Node 22, pnpm 10 (`corepack enable`) y Docker.

```bash
pnpm install
pnpm infra:up      # PostgreSQL, Redis y LocalStack (SNS/SQS)
pnpm dev:setup     # llaves de desarrollo en .dev/ y archivos services/*/.env
pnpm apps:up       # construye imágenes, migra las bases y arranca ambos servicios
```

Está listo cuando ambos responden `{"status":"ready"}`:

```bash
curl -s localhost:3001/health/ready
curl -s localhost:3000/health/ready
```

Con `pnpm apps:up` el servicio lending corre con el **reloj de desarrollo** habilitado (necesario para simular facturación, ver sección 5). Si prefieres correr los servicios en tu máquina: `pnpm build`, `pnpm --filter @acme/collateral prisma:migrate:deploy`, `pnpm --filter @acme/lending prisma:migrate:deploy`, `pnpm dev:collateral` y `pnpm dev:lending` (el `.env` de lending ya trae `DEV_CLOCK=true`).

Para apagar: `pnpm apps:down`. Para empezar de cero (borra todos los datos): `docker compose --profile apps down -v`.

## 2. Datos de prueba (seed)

```bash
pnpm seed
```

Crea, de forma idempotente, un cliente de prueba con cuenta de custodia, un depósito de 111112 (el mínimo que, al 90 %, da un cupo de 100000 centavos = 1000.00 USD) confirmado por el banco simulado y una tarjeta activa. Se puede ejecutar cuantas veces se quiera: devuelve siempre los mismos identificadores. Imprime JSON:

| Campo | Contenido |
| --- | --- |
| `userId` | `test-user` (cambia con `--user=otro`) |
| `custodyAccountId` | Cuenta de custodia con 111112 retenidos |
| `cardAccountId` | Tarjeta ACTIVE con cupo 100000 (1000.00 USD) y día de corte 15 |
| `depositReference` | Referencia del depósito ya confirmado |
| `account` | Estado inicial de la tarjeta |
| `tokens.user` | JWT del cliente (dueño de las cuentas) |
| `tokens.cardNetwork` | JWT de servicio con scope `authorizations:write` (la red de tarjetas) |
| `tokens.scheduler` | JWT de servicio con scope `jobs:run` (jobs diarios y reloj de desarrollo) |

Opciones: `--user=<id>`, `--cupo=<centavos>` (cupo deseado; el depósito se calcula según el ratio), `--amount=<centavos>` (depósito exacto), `--cycle-day=1|15`, `--ttl=12h`. Los tokens duran 12 h por defecto.

Para guardar los valores en variables de shell:

```bash
SEED=$(pnpm -s seed)
USER_TOKEN=$(echo "$SEED" | jq -r .tokens.user)
NETWORK_TOKEN=$(echo "$SEED" | jq -r .tokens.cardNetwork)
SCHEDULER_TOKEN=$(echo "$SEED" | jq -r .tokens.scheduler)
CARD=$(echo "$SEED" | jq -r .cardAccountId)
CUSTODY=$(echo "$SEED" | jq -r .custodyAccountId)
```

Si necesitas otro token: `pnpm -s token -- --sub=otro-cliente` (cliente) o `pnpm -s token -- --sub=card-network --principal=service --scope=authorizations:write`.

## 3. Verificación automática

```bash
pnpm scenarios              # 12 escenarios, 61 verificaciones
pnpm scenarios -- --only=1,2,4
pnpm scenarios -- --verbose
```

Cada escenario crea su propio cliente (no depende del seed) y imprime `✔`/`✘` con lo esperado y lo recibido. El código de salida es `0` si todo pasa, `1` si algo falla y `2` si los servicios no están levantados. Si un agente solo necesita un veredicto, esto es suficiente; el resto de la guía explica qué verifica cada escenario para poder hacerlo a mano.

## 4. Casos de uso y resultado esperado

Los ejemplos usan las variables de la sección 2. Todas las peticiones con cuerpo llevan `-H 'content-type: application/json'`; para brevedad se omite abajo. Usa `Idempotency-Key: $(uuidgen)` en cada operación nueva.

### 4.1 Consultar la tarjeta

```bash
curl -s localhost:3000/accounts/$CARD -H "Authorization: Bearer $USER_TOKEN"
```

Esperado (cuenta recién creada con el seed): `200`, `status: "ACTIVE"`, `balances.debt: 0`, `limit.cupo: 100000`, `availableCredit: 100000`.

### 4.2 Compra aprobada y compra rechazada

La autorización la hace la red de tarjetas (token de servicio):

```bash
curl -s -X POST localhost:3000/accounts/$CARD/authorizations -H "Authorization: Bearer $NETWORK_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" -d '{"amount":60000,"merchant":"tienda"}'
```

| Petición | Respuesta esperada |
| --- | --- |
| compra de `60000` con 100000 disponibles | `201`, `status: "APPROVED"`, `availableCredit: 40000`, `authorizationId` |
| compra de `40001` con 40000 disponibles | `200`, `status: "DECLINED"`, `reason: "INSUFFICIENT_CREDIT"` |
| compra de `40000` con 40000 disponibles | `201`, `APPROVED`, `availableCredit: 0` |

Una compra rechazada **no** es un error HTTP: responde `200` con `DECLINED`. La deuda nunca supera el cupo.

### 4.3 Idempotencia

- Repetir la misma petición con la misma `Idempotency-Key` devuelve la misma respuesta (mismo `authorizationId`) y no cobra dos veces.
- La misma clave con otro cuerpo: `422`, `code: "IDEMPOTENCY_KEY_REUSED"`.
- Sin el encabezado: `400`.

### 4.4 Pagos

```bash
curl -s -X POST localhost:3000/accounts/$CARD/payments -H "Authorization: Bearer $USER_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" -d '{"amount":20000}'
```

Esperado con 60000 de deuda en capital: `201`, `applied: [{"bucket":"PRINCIPAL","amount":20000}]`, `debt: 40000`, y el disponible sube 20000. Un pago mayor que la deuda: `422`, `PAYMENT_EXCEEDS_DEBT`. Los pagos se aplican primero a cargos, luego a intereses y al final a capital.

### 4.5 Reverso de una autorización

```bash
curl -s -X POST localhost:3000/accounts/$CARD/authorizations/<authorizationId>/reversals \
  -H "Authorization: Bearer $NETWORK_TOKEN" -H "Idempotency-Key: $(uuidgen)"
```

Esperado: `201` y el crédito se restaura. Un segundo reverso de la misma autorización: `409`, `ALREADY_REVERSED`.

### 4.6 Compra diferida a cuotas

```bash
curl -s -X POST localhost:3000/accounts/$CARD/authorizations -H "Authorization: Bearer $NETWORK_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" -d '{"amount":12000,"installments":3}'
```

| Caso | Esperado |
| --- | --- |
| `installments: 3` con 12000 | `201`, `APPROVED`; el disponible baja 12000 completos; `balances.deferred: 12000` y `balances.principal` sin cambio |
| `installments: 4` | `422`, `INSTALLMENTS_NOT_AVAILABLE` (se ofrecen 3, 6 y 12) |
| `amount: 4999` con cuotas | `422`, `AMOUNT_BELOW_INSTALLMENT_MINIMUM` (mínimo 5000) |
| pagar lo diferido | `422`, `PAYMENT_EXCEEDS_DEBT` (no se paga por adelantado) |
| reversar antes del primer corte | `201`; después de que empiece a facturarse: `422`, `DEFERRED_PURCHASE_ALREADY_BILLED` |

Las cuotas se facturan una por corte (ver sección 5). Plan por cliente: `GET /accounts/$CARD/installment-plans`.

### 4.7 Depósito adicional y cambio de cupo por evento

```bash
REF=$(curl -s -X POST localhost:3001/custody-accounts/$CUSTODY/deposits -H "Authorization: Bearer $USER_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" -d '{"bankId":"sim-bank","amount":50000}' | jq -r .reference)
pnpm bank:confirm -- --reference=$REF --amount=50000      # webhook firmado del banco
curl -s localhost:3000/accounts/$CARD -H "Authorization: Bearer $USER_TOKEN" | jq .limit.cupo
```

Esperado: `bank:confirm` responde `200 {"status":"CONFIRMED"}`. En pocos segundos el cupo en lending pasa de `100000` a `145000` (161112 retenidos x 90 %) sin que lending consulte a collateral en esa petición: llega por el evento SNS/SQS. Para el banco con HMAC: `--bank=hmac-bank` y `"bankId":"hmac-bank"` al crear el depósito.

### 4.8 Reducción de cupo

```bash
curl -s -X POST localhost:3000/accounts/$CARD/limit-reduction -H "Authorization: Bearer $USER_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" -d '{"newCupo":45000}'
```

Esperado: `200 {"status":"APPLIED","newCupo":45000}` si la deuda cabe en el nuevo cupo; el cupo baja y collateral libera el colateral sobrante. Un cupo menor que la deuda: `422`, `DEBT_EXCEEDS_NEW_LIMIT`.

### 4.9 Cierre de la cuenta

```bash
curl -s -X POST localhost:3000/accounts/$CARD/closure -H "Authorization: Bearer $USER_TOKEN" -H "Idempotency-Key: $(uuidgen)"
```

Esperado: `200 {"status":"CLOSED","debt":0}`. El colateral se aplica a la deuda y el resto se libera: `GET localhost:3001/custody-accounts/$CUSTODY` pasa a `status: "CLOSED"` y `heldAmount: 0`. Después, cualquier compra responde `DECLINED` con `ACCOUNT_NOT_ACTIVE` y un segundo cierre `409`.

### 4.10 Seguridad (deben fallar)

| Petición | Esperado |
| --- | --- |
| cualquier endpoint sin token | `401` |
| token de otro cliente sobre la cuenta | `404` (no revela que existe) |
| un cliente autorizando una compra o liquidando colateral | `403` |
| webhook del banco con firma falsa o sin firma | `401` |
| webhook con un monto distinto al del depósito | `422`, `DEPOSIT_AMOUNT_MISMATCH` |
| emitir una tarjeta sobre una custodia sin colateral confirmado | `422`, `NO_COLLATERAL` |
| segunda tarjeta para la misma custodia | `409`, `CARD_ALREADY_EXISTS` |

## 5. Simular el paso del tiempo (intereses, estados de cuenta, mora)

Los cortes son los días 1 y 15, el vencimiento 20 días después y el cierre por impago a los 90 días de mora. Para no esperar, lending expone un **reloj de desarrollo** que solo avanza hacia adelante (requiere `DEV_CLOCK=true`; el servicio se niega a arrancar así en producción):

```bash
curl -s localhost:3000/internal/dev/clock -H "Authorization: Bearer $SCHEDULER_TOKEN"                       # hora actual simulada
curl -s -X POST localhost:3000/internal/dev/clock -H "Authorization: Bearer $SCHEDULER_TOKEN" \
  -H 'content-type: application/json' -d '{"days":35}'                                                      # avanzar (o {"to":"2027-01-20T00:00:00Z"})
curl -s -X POST localhost:3000/internal/jobs/daily -H "Authorization: Bearer $SCHEDULER_TOKEN"              # ejecutar los jobs diarios
```

Secuencia sugerida con una tarjeta que tenga una compra normal de 60000 y una diferida de 12000 en 3 cuotas:

| Paso | Esperado |
| --- | --- |
| avanzar `35` días y ejecutar los jobs | `statementsIssued >= 1` |
| `GET /accounts/$CARD/statements/1` | `installmentPrincipal: 4000`, `deferredBalance: 8000`, `interestCharged > 0`, `closingBalance = 60000 + interestCharged + 4000`, `minimumPayment >= 4000` |
| avanzar `20` días más y ejecutar los jobs sin pagar | `statementsLate >= 1`; la cuenta queda `DELINQUENT` con `balances.fees > 0` (cargo por mora) y las compras se rechazan con `ACCOUNT_NOT_ACTIVE` |
| pagar el `minimumPayment` del estado de cuenta | `201`; la cuenta vuelve a `ACTIVE` |
| avanzar hasta 90 días de mora sin pagar | `accountsChargedOff >= 1`: la cuenta se cierra sola y se aplica el colateral |

El reloj no retrocede. Cada ejecución de `pnpm scenarios` lo adelanta unos 55 días; es normal. Para volver a la hora real: `docker compose --profile apps down -v` y levantar de nuevo.

## 6. Códigos de error que puedes encontrar

| `code` | HTTP | Significado |
| --- | --- | --- |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Misma clave con otro cuerpo |
| `INSUFFICIENT_CREDIT` / `ACCOUNT_NOT_ACTIVE` | 200 (`DECLINED`) | Motivos de rechazo de una autorización |
| `LIMIT_UNAVAILABLE` | 503 | No se pudo determinar el cupo (caché vencida y collateral caído con política `deny`) |
| `NO_COLLATERAL` | 422 | No hay colateral confirmado |
| `CARD_ALREADY_EXISTS` | 409 | Ya hay una tarjeta para esa custodia |
| `PAYMENT_EXCEEDS_DEBT` | 422 | Pago mayor que lo pagable |
| `ACCOUNT_NOT_PAYABLE` | 409 | La cuenta se está cerrando o ya cerró |
| `ALREADY_REVERSED` / `REVERSAL_EXCEEDS_BALANCE` | 409 / 422 | Reverso repetido, o la compra ya se pagó |
| `INSTALLMENTS_NOT_AVAILABLE` / `AMOUNT_BELOW_INSTALLMENT_MINIMUM` | 422 | Plan de cuotas no ofrecido o monto bajo el mínimo |
| `DEFERRED_PURCHASE_ALREADY_BILLED` | 422 | La compra diferida ya empezó a facturarse |
| `DEBT_EXCEEDS_NEW_LIMIT` / `REDUCTION_IN_PROGRESS` | 422 / 409 | Reducción de cupo no válida o ya en curso |
| `DEPOSIT_AMOUNT_MISMATCH` / `DEPOSIT_NOT_FOUND` / `DEPOSIT_NOT_PENDING` | 422 / 404 / 409 | Webhook que no coincide con el depósito |
| `ACCOUNT_CLOSED` | 409 | Operación sobre una cuenta cerrada |
| `CUSTODY_ACCOUNT_NOT_FOUND` / `ACCOUNT_NOT_FOUND` | 404 | Recurso inexistente o ajeno |

## 7. Inspeccionar el estado por debajo

```bash
# Saldos y diario de la tarjeta
docker compose exec postgres psql -U lending -d lending -c \
  "select type, bucket, direction, amount, effective_at from movements where account_id = '$CARD' order by created_at"
docker compose exec postgres psql -U lending -d lending -c \
  "select cycle_number, period_end, due_date, closing_balance, minimum_payment from statements where account_id = '$CARD' order by cycle_number"
# Colateral y su diario
docker compose exec postgres psql -U collateral -d collateral -c \
  "select type, amount, held_after from custody_movements where custody_account_id = '$CUSTODY' order by created_at"
# Auditoría (quién hizo qué, con id de correlación)
docker compose exec postgres psql -U lending -d lending -c \
  "select actor_id, action, entity_type, created_at from audit_log order by created_at desc limit 20"
# Caché del cupo y mensajería
docker compose exec redis redis-cli HGETALL limit:$CUSTODY
docker compose exec localstack awslocal sqs list-queues
```

El diario y la auditoría son de solo inserción: un `UPDATE` o `DELETE` sobre `movements`, `custody_movements`, `statements` o `audit_log` falla por diseño.

## 8. Qué no esperar

- Los bancos son simuladores (`sim-bank` con Ed25519 y `hmac-bank` con HMAC); `pnpm bank:confirm` firma como ellos.
- La identidad es una llave de desarrollo: los tokens salen de `pnpm token` o del seed, no de un proveedor real.
- El reloj de desarrollo y los seeds existen solo en local.
- No hay pago anticipado de cuotas, congelamiento de tarjeta ni devoluciones sobre compras ya pagadas.

## 9. Qué reportar

Si un agente prueba el sistema, un reporte útil incluye: salida de `pnpm scenarios` (verificaciones correctas/total), el resultado de cualquier caso de la sección 4 que haya repetido a mano (código HTTP y campos clave) y, si algo falló, la respuesta completa, la hora simulada (`GET /internal/dev/clock`) y las últimas filas de `audit_log`.
