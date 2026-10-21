# Flujos principales

Los montos son enteros en centavos. Toda operación que mueve dinero exige `Idempotency-Key`.

## 1. Apertura: custodia, depósito y tarjeta

```mermaid
sequenceDiagram
    actor C as Cliente
    participant Col as collateral-service
    participant B as Banco simulado
    participant L as lending-service

    C->>Col: abrir cuenta de custodia
    C->>Col: depositar monto
    Col-->>C: depósito PENDING
    B->>Col: webhook firmado de confirmación
    Col->>Col: depósito CONFIRMED, retenido y cupo actualizados
    C->>L: solicitar tarjeta (custodyAccountId, día de corte 1 o 15)
    L->>Col: GET cupo
    alt cupo mayor a cero y la cuenta es del cliente
        L->>L: crea cuenta ACTIVE con su diario vacío y la versión de condiciones vigente
        L-->>C: tarjeta activa
    else sin colateral confirmado
        L-->>C: rechazada
    end
```

## 2. Autorización de una compra

```mermaid
sequenceDiagram
    actor M as Comercio / red
    participant L as lending-service
    participant R as Redis
    participant Col as collateral-service
    participant DB as Postgres lending

    M->>L: POST autorización (Idempotency-Key, monto)
    L->>R: cupo de la cuenta
    alt dato vigente
        R-->>L: cupo y versión
    else ausente o vencido
        L->>Col: GET cupo (timeout corto)
        alt responde
            Col-->>L: cupo y versión
            L->>R: guarda si la versión es mayor
        else falla
            alt política use_stale y edad dentro del máximo
                R-->>L: último cupo conocido
            else política deny o sin dato
                L-->>M: rechazada, no procesable ahora
            end
        end
    end
    L->>DB: BEGIN, bloquea la fila de la cuenta
    L->>DB: valida estado ACTIVE e idempotencia
    L->>L: disponible = min(cupo, tope propio) - deuda
    alt monto dentro del disponible
        L->>DB: inserta PURCHASE y actualiza saldo
        L->>DB: COMMIT
        L-->>M: aprobada
    else excede
        L->>DB: ROLLBACK
        L-->>M: rechazada por límite
    end
```

La lectura de Redis y la consulta a custodia ocurren antes de abrir la transacción, nunca con la fila bloqueada.

## 3. Pago

```mermaid
sequenceDiagram
    actor C as Cliente
    participant L as lending-service
    participant DB as Postgres lending

    C->>L: POST pago (Idempotency-Key, monto)
    L->>DB: BEGIN, bloquea la cuenta
    alt monto mayor a la deuda
        L-->>C: rechazado
    else
        L->>DB: aplica en cascada: cargos, intereses, capital
        L->>DB: COMMIT
        L-->>C: pago aplicado, crédito restaurado
    end
```

## 4. Ciclo de facturación y mora

```mermaid
sequenceDiagram
    participant S as Scheduler (EventBridge en AWS)
    participant Bill as billing
    participant Acc as accounts
    participant Col as collateral-service

    S->>Bill: corte diario
    Bill->>Bill: cuentas cuyo ciclo cierra hoy
    Bill->>Acc: postea INTEREST (saldo diario promedio de capital)
    Bill->>Bill: genera estado de cuenta inmutable con pago mínimo y vencimiento
    S->>Bill: chequeo de mora
    Bill->>Bill: estados vencidos sin pagar el mínimo
    Bill->>Acc: postea LATE_FEE una sola vez por estado
    Bill->>Acc: cuenta pasa a DELINQUENT
    Bill->>Acc: mora mayor a N días: iniciar cierre por impago
    Acc->>Col: liquidación (ver flujo 5)
```

Cada paso es idempotente por clave única (cuenta y ciclo, estado y tipo), así que ejecutar el job dos veces no duplica nada.

## 5. Cierre y liquidación del colateral

```mermaid
sequenceDiagram
    actor C as Cliente
    participant L as lending-service
    participant Col as collateral-service

    C->>L: solicitar cierre
    L->>L: cuenta CLOSING (rechaza nuevas compras), calcula deuda D
    loop hasta confirmar (job de reintento)
        L->>Col: POST liquidación (clave de cierre, aplicar D)
        Col->>Col: aplicado = min(D, retenido), libera el resto al cliente
        Col-->>L: aplicado y liberado
    end
    L->>L: registra pago por colateral, remanente como pérdida
    L->>L: cuenta CLOSED
    L-->>C: cuenta cerrada
```

La orden es idempotente por la clave de cierre. Si la llamada falla, la cuenta permanece en `CLOSING` y el job reintenta.

## 6. Cambio de cupo por depósito (aumento)

```mermaid
sequenceDiagram
    actor C as Cliente
    participant Col as collateral-service
    participant SNS as SNS
    participant Q as SQS lending
    participant L as lending-service
    participant R as Redis

    C->>Col: depositar más colateral
    Col->>Col: confirma el depósito, cupo y versión nuevos
    Col->>Col: escribe el evento en el outbox (misma transacción)
    Col->>SNS: publica custody.limit-changed (accountId, version)
    SNS->>Q: entrega
    L->>Q: recibe el mensaje
    L->>Col: GET cupo
    L->>R: guarda si la versión es mayor
    L->>Q: ack (borra el mensaje) solo tras escribir en Redis
```

Si falla Redis o custodia, no hay ack: el mensaje reaparece tras el tiempo de visibilidad y, agotados los intentos, va a la DLQ con alerta. Un duplicado o un mensaje antiguo no hace daño porque solo se acepta una versión mayor. Si un evento se pierde, el TTL del cupo lo corrige en un máximo de 12 horas.

## 7. Reducción de cupo o retiro parcial

```mermaid
sequenceDiagram
    actor C as Cliente
    participant L as lending-service
    participant DB as Postgres lending
    participant Col as collateral-service
    participant R as Redis

    C->>L: pedir nuevo cupo menor
    L->>DB: BEGIN, bloquea la cuenta
    L->>L: valida deuda menor o igual al nuevo cupo y sin mora
    L->>DB: fija tope propio = nuevo cupo, COMMIT
    L->>Col: POST reducción de cupo (clave idempotente)
    Col->>Col: baja el cupo, sube la versión, libera el colateral sobrante
    Col-->>L: cupo y versión nuevos
    L->>R: guarda si la versión es mayor
    L->>DB: retira el tope propio
    L-->>C: cupo actualizado
```

El tope propio se guarda en Postgres dentro de la misma transacción que valida la deuda, así ninguna compra puede superar el nuevo cupo mientras Redis aún tiene el anterior. Solo se retira después de escribir el valor nuevo en Redis. Si la llamada a custodia o la escritura fallan, el tope permanece y un job de reintento completa la operación con la misma clave idempotente.
