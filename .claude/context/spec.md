# Especificación del reto: Acme Credit lending service

## Problema

Construir un servicio nuevo para Acme Credit, fintech que lanza una tarjeta de crédito asegurada: antes de tener una tarjeta activa, el cliente deposita dinero como garantía (colateral). El depósito define el límite de crédito y protege a la empresa si el cliente no paga.

El servicio es dueño del flujo de lending. Como mínimo:

- Depósito de colateral: recibir y confirmar el depósito.
- Activación de tarjeta: solo activa cuando el colateral está confirmado, con límite derivado del depósito.
- Gasto: autorizar compras contra el crédito disponible. Una compra nunca puede exceder el límite.
- Pagos: el cliente paga lo gastado y se restaura su crédito disponible.
- Liberación o aplicación del colateral: devolver el depósito al cerrar la cuenta en buen estado, o aplicarlo a deuda impaga.

Más allá es opcional: intereses, estados de cuenta, cargos por mora, aumentos de límite, congelar tarjeta, etc. Es un servicio crítico: se mueve dinero y parte es garantía. Deben existir todas las medidas y estrategias necesarias para que funcione como se espera.

## Instrucciones

- Arquitectura: se recomienda microservicio, pero se puede elegir otro estilo. Explicar por qué, con conceptos claros y lo más a fondo posible.
- Servicio crítico: garantizar concurrencia segura (ej. dos compras simultáneas sobre la misma tarjeta), seguridad, consistencia de datos, idempotencia, auditabilidad y manejo correcto de montos de dinero.
- Infraestructura: no se necesita DB ni auth reales; se pueden simular en memoria. Opcional PostgreSQL, SQLite u otro. Si se usan servicios reales, facilitar correrlos en local (contenedores).
- Cloud native: no hay que desplegar. Explicar cómo se desplegaría en un proveedor (ej. AWS) e incluir alguna forma de IaC.
- Uso de IA: permitido. Recomendado decirle a la IA qué hacer en vez de preguntarle cómo pensar.
- Prompts (obligatorio si se usa IA): incluir todos los prompts y respuestas, en orden, de todas las herramientas de IA (chat, agentes de código, copilotos de IDE). `PROMPTS.md` o log exportado en el repo.
- Proceso de pensamiento: describir elecciones de arquitectura, stack y estrategia para las partes críticas, con trade-offs considerados.
- Plazo: 5 días calendario desde la recepción.
- Entrega: GitHub, ZIP en Google Drive o un PDF.
- Demo en vivo: opcional, pero compartiendo el código fuente.
- Stack: libre, idealmente Python, TypeScript o Go.

El reto es abierto a propósito. Se valora calidad sobre cantidad, creatividad y toque personal.
