# Seguridad: identidad y autorización

## Supuesto

Existe un proveedor de identidad externo (por ejemplo Clerk u otro equivalente) que autentica a los usuarios y emite JWT firmados de vida corta. Este servicio no gestiona usuarios, credenciales ni sesiones, y no depende de un proveedor concreto: solo valida tokens.

## Autenticación

- Un guard de Nest valida cada token: firma, `iss`, `aud` y `exp`. Pasada esa validación, las claims son de confianza.
- Puerto `TokenVerifier` en `lib/auth`. Un solo adaptador, configurado por entorno con una llave pública fija o con una URL de JWKS.
- En desarrollo, un script del repo mintea tokens con una llave local, de modo que el camino de verificación es el real.
- Los JWT van firmados, no cifrados: los tokens llevan solo las claims necesarias y ningún dato personal sensible.

## CurrentUser

- El guard construye `CurrentUser` con `userId` (la claim `sub`), `scopes` y el tipo de principal (`user` o `service`).
- Los controladores lo reciben con el decorador `@CurrentUser()` y lo pasan como parámetro explícito al caso de uso.
- Para la auditoría, `nestjs-cls` mantiene el actor y el id de correlación en un contexto asíncrono, sin pasarlos por cada capa.

## Autorización

- Puerto `AccessPolicy` con `can(currentUser, acción, recurso)`. Hoy su adaptador aplica localmente la regla de dueño y los scopes del token. Si existe un servicio de autorización, se escribe un adaptador remoto, con caché si hace falta.
- Las cuentas (de tarjeta y de custodia) llevan `ownerId`, que es el `sub` del token y se guarda como texto. No hay tabla de usuarios propia.
- Un principal `user` solo accede a entidades cuyo `ownerId` coincide. Se aplica en el repositorio (`findOwned(id, ownerId)`), de modo que no se pueda olvidar el filtro. Si no coincide, la respuesta es 404, no 403, para no revelar que la cuenta existe.
- Los principales `service` no tienen dueño y se limitan por scope.

| Operación | Principal | Regla |
| --- | --- | --- |
| Solicitar tarjeta, ver, pagar, cerrar, reducir cupo | user | dueño de la cuenta |
| Autorizar compra | service (red de tarjetas) | scope `authorizations:write` |
| Confirmar depósito | tercero (banco) | webhook firmado, ver sección siguiente |
| Consultar cupo, liquidar, reducir en custodia | service (lending) | scopes `custody:read` y `custody:settle` |
| Jobs de corte y mora | interno | no expuesto por HTTP de cliente |

- Entre lending y custodia se usa un token de servicio más el `ownerId` explícito. Al solicitar una tarjeta, lending compara el `ownerId` que informa custodia con el del usuario y rechaza si no coinciden.
- Los eventos de SNS y SQS no llevan token: los controla IAM, y no llevan datos personales.
- La autorización de compras decide solo con las claims del token, sin llamar a ningún servicio remoto.

## Webhooks de los bancos

Los bancos avisan los depósitos con un webhook a `POST /webhooks/banks/:bankId` en custodia. Es el único endpoint expuesto a terceros y el más delicado, porque confirmar un depósito falso crearía cupo de la nada. Pueden existir varios bancos, cada uno con su propio esquema de verificación.

- **Firma asimétrica (preferida):** el banco firma con su llave privada y custodia guarda solo su llave pública, identificada por `kid`. Puede haber varias llaves activas por banco para rotar sin cortes.
- **HMAC-SHA256 (para bancos que solo soportan secreto compartido; implementado en `HmacBankAdapter`, banco `hmac-bank`):** firma sobre el cuerpo crudo con marca de tiempo, comparada en tiempo constante. No se acepta un token fijo en un encabezado, porque no protege el cuerpo y se filtra en logs.
- **Marca de tiempo firmada** con tolerancia corta, para rechazar repeticiones.
- **Referencia por depósito:** la genera custodia, impredecible, y el banco debe devolverla. Un atacante tendría que conocerla además de falsificar la firma.
- **Idempotencia** por banco e id de evento.
- **Validación de negocio:** el depósito debe existir en `PENDING` para ese banco, y monto, cuenta y referencia deben coincidir. Cualquier discrepancia se rechaza y se audita.
- **Verificación al origen (recomendada):** antes de acreditar, custodia consulta el estado del depósito al banco.
- Responde 2xx rápido; el banco reintenta si no.
- Llaves y secretos en el gestor de secretos, nunca en el código.
- Solo este endpoint es público (balanceador con WAF). Todo lo demás es interno.

### Soporte de varios bancos

- Puerto `BankAdapter` en `src/clients/banks` con dos operaciones: verificar y normalizar un webhook (firma y formato propio del banco) y consultar el estado de un depósito.
- El adaptador devuelve siempre el mismo evento interno: banco, id de evento, referencia, monto, moneda y fecha. El dominio no conoce formatos de banco.
- Un registro resuelve el adaptador y sus llaves por `bankId`. Hoy solo existe el adaptador del banco simulado.
- Cada depósito guarda su `bankId`.
- En desarrollo, un comando local firma y envía el webhook simulado con la llave del banco simulado, de modo que ejercita el camino real.

## Otras reglas

- La clave de idempotencia se acota por principal (`ownerId` más clave).
- El estado de la cuenta (congelada, en mora, cerrada) se lee siempre de la base de datos, nunca del token.
- Los cambios de permisos tardan, como máximo, la vida del token en notarse.
