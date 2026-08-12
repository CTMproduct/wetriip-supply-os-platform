# Wetriip Supply OS — Arquitectura completa

Documento de referencia único. Describe **código que existe y corre**, no una
propuesta. Donde algo está deliberadamente sin construir, se marca
**[NO CONSTRUIDO]** con la razón.

- 35.070 líneas de TypeScript
- 9 servicios desplegables independientemente
- 7 paquetes compartidos
- 45 modelos de datos, 37 enums
- 69 rutas públicas, 103 rutas internas
- 175 pruebas unitarias (12 suites), 102 verificaciones end-to-end

---

## Índice

1. [La decisión que ordena todo lo demás](#1-la-decisión-que-ordena-todo-lo-demás)
2. [Topología: por qué nueve servicios](#2-topología-por-qué-nueve-servicios)
3. [Paquetes compartidos](#3-paquetes-compartidos)
4. [Los motores deterministas](#4-los-motores-deterministas)
5. [Modelo de datos completo](#5-modelo-de-datos-completo)
6. [ARI: el modelo canónico](#6-ari-el-modelo-canónico)
7. [Conectividad: adaptadores y resiliencia](#7-conectividad-adaptadores-y-resiliencia)
8. [Búsqueda, precio y ofertas](#8-búsqueda-precio-y-ofertas)
9. [Reservas: la saga](#9-reservas-la-saga)
10. [Grupos y salones](#10-grupos-y-salones)
11. [El Agent Control Plane](#11-el-agent-control-plane)
12. [Identidad, roles y permisos](#12-identidad-roles-y-permisos)
13. [API pública completa](#13-api-pública-completa)
14. [El front end](#14-el-front-end)
15. [Observabilidad y errores](#15-observabilidad-y-errores)
16. [Resiliencia](#16-resiliencia)
17. [Cómo correrlo](#17-cómo-correrlo)
18. [Qué es real y qué no](#18-qué-es-real-y-qué-no)

---

## 1. La decisión que ordena todo lo demás

> **El LLM nunca modifica inventario, precio, contratos ni reservas.**
> Entiende la intención. Un sistema determinístico valida, simula, autoriza y
> ejecuta.

Concretamente: la única salida permitida de un modelo es un valor de la unión
cerrada `StructuredCommandSchema` (`packages/contracts/src/agent.ts`). Existen
**19 tipos de comando**: 9 de lectura, 10 de escritura. Nada fuera de esa unión
puede expresarse, así que nada fuera de esa unión puede ocurrir.

```
utterance ──► intent ──► StructuredCommand ──► simulación ──► política
                               │                                  │
                               │                     ┌────────────┴────────────┐
                               │                  permitido                negado
                               │                     │                        │
                               │              confirmación                 auditoría
                               │                     │
                               │              ejecución (solo capa MANAGED)
                               │                     │
                               │              verificación + auditoría
                               ▼                     ▼
                        rechazado + auditoría   rollback disponible
```

**La simulación corre ANTES que la política**, a propósito: la mitad de los
límites (blast radius, tarifa piso, ADR resultante) solo se conocen una vez
calculado el diff. Un motor de política que corre primero solo puede revisar lo
que el usuario escribió — justamente el conjunto de cosas que un comando
equivocado acierta.

### Las 16 reglas no negociables

Viven en `CLAUDE.md` y se revisan en cada cambio:

1. El LLM nunca modifica inventario, precio, contratos ni reservas.
2. El ledger es append-only. Sin update, sin delete, sin reescritura de estado.
3. EXTERNAL nunca es sobrescrito por MANAGED. Los overrides son otra capa con
   actor, razón y ventana de validez.
4. Ajustes contractuales y promocionales **nunca** entran al ledger ARI.
   Pertenecen a la construcción de la oferta.
5. Los motores deterministas no hacen I/O. Lo que esté en `packages/domain` es
   función pura de sus entradas o no pertenece ahí.
6. Toda ruta de escritura es idempotente. Si no puede nombrar la llave, no
   terminó.
7. La autoridad del agente se **deriva** del usuario, nunca se otorga aparte.
8. El contenido se estratifica como ARI. Una imagen importada sin crédito y
   licencia se retiene, no se muestra.
9. La distribución se evalúa antes que los contratos y antes que el precio.
10. El crédito solo se mueve por el ledger. `creditUsed` nunca se asigna directo.
11. Los estados vacíos declaran su causa. Nunca un arreglo vacío donde un error
    tipado con dueño y remediación le diría al operador qué hacer.
12. El permiso es la unidad de autoridad; el rol es un paquete.
13. Nadie reparte autoridad que no tiene, y ningún permiso que deje a un tenant
    ver a otro puede otorgarse desde dentro de un tenant.
14. El inventario de grupos es **declarado**, no observado, y nunca entra al
    ledger ARI.
15. Una negociación es append-only y sobre un reloj guardado.
16. Nunca reportar una notificación como enviada si un proveedor no la aceptó.

---

## 2. Topología: por qué nueve servicios

El corte sigue **aislamiento de fallos y curvas de escalamiento**, no tablas de
base de datos.

| Servicio | Puerto | Posee | Qué lo escala | Qué falla debe sobrevivir solo |
|---|---|---|---|---|
| `gateway` | 3100 | AuthN, composición BFF, consola | fan-out de requests | ninguno (stateless) |
| `core-commerce` | 3110 | Propiedad, habitaciones, planes, impuestos, contenido, distribución, partners, contratos, promociones, usuarios | bajo, transaccional | ninguno |
| `connectivity` | 3120 | Adaptadores, webhooks, pull, versiones de mapeo | proveedores × propiedades | un proveedor caído, lento o limitando |
| `ari-ingestion` | 3130 | Ledger, celdas por capa, Effective ARI, salud | throughput de escritura, ráfagas | una ráfaga de full sync |
| `search` | 3140 | Sellability, precio, ofertas, diagnóstico, revenue, demanda | QPS de lectura, p95 800 ms | un caché frío |
| `booking` | 3150 | Saga, idempotencia, llamadas al proveedor | volumen bajo, criticidad máxima | un timeout del proveedor |
| `agent` | 3160 | Intención, política, simulación, ejecución, rollback, chat | latencia y costo del LLM | el modelo no disponible |
| `reconciliation` | 3170 | Detección de divergencias | batch, fuera de pico | ser lento |
| `groups` | 3180 | Bloqueos, beneficios, negociación, notificaciones, salones | volumen bajo, estado largo, dirigido por plazos | una negociación atascada |

**`services/all-in-one`** levanta los nueve módulos en un proceso, con las
mismas rutas y las mismas llamadas HTTP entre ellos. Un contrato roto entre
servicios falla en el portátil, no en staging. No es la topología de
producción: aquí todo escala y falla junto, que es exactamente lo que el corte
existe para evitar.

### Propiedad de datos

Una instancia de Postgres en etapa 1, con **propiedad estricta de tablas**: un
servicio lee y escribe solo su agregado y alcanza otros dominios por API o
evento, nunca por join. Esa restricción es lo que convierte el split posterior
a bases separadas en un cambio de configuración y no en una reescritura.

```
core-commerce   Tenant Organization User Property RoomType RatePlan TaxRule
                PropertyContent PropertyImage ContentSource DistributionPolicy
                PartnerProfile CreditEntry Contract ContractVersion
                Promotion PromotionVersion
connectivity    Connection MappingVersion MappingEntry RawEnvelope
ari-ingestion   AriEvent AriCell EffectiveAri
search          SearchRequest Offer SearchImpression
booking         Booking BookingAttempt
agent           AgentSession AgentMessage AgentAction AgentPolicy
groups          GroupBlock GroupBlockLine GroupPolicy GroupRequest GroupBid
                Notification EventSpace
reconciliation  ReconciliationRun Divergence
compartido      AuditEvent OutboxEvent IdempotencyRecord (append-only)
```

### Comunicación

- **Asíncrona**: outbox transaccional → relay. Kafka/Redpanda encaja detrás de
  la misma interfaz sin tocar los servicios.
- **Síncrona**: clientes tipados de `@wetriip/service-kit` que preservan el
  código de error y el correlationId a través del salto. Un `POLICY_DENIED`
  levantado en `agent` sigue leyéndose como `POLICY_DENIED` en el gateway en
  vez de degradarse a un 500.

---

## 3. Paquetes compartidos

| Paquete | Qué es | Regla |
|---|---|---|
| `@wetriip/contracts` | Tipos, esquemas Zod, catálogo de eventos, taxonomía de errores, topología | Lo único que todo servicio puede compartir |
| `@wetriip/domain` | 20 motores deterministas + sus specs | Función pura de sus entradas. Cero I/O |
| `@wetriip/connectivity-sdk` | Contrato de adaptador, runtime de resiliencia, suite de conformidad | Un dialecto de proveedor por archivo |
| `@wetriip/persistence` | Cliente Prisma, outbox, auditoría, idempotencia, decimales | Mapa de propiedad documentado aquí |
| `@wetriip/service-kit` | Bootstrap, contexto, clientes, filtro de errores, guardas | Un `systemContext()` para identidades de máquina |
| `@wetriip/bus` | Interfaz de bus + implementación en memoria | Sustituible sin tocar servicios |
| `@wetriip/observability` | Logger estructurado con redacción por nombre de llave | La redacción se aplica en el logger, no se confía al llamador |

**Los servicios no se importan entre sí.** Comparten `contracts` y hablan HTTP.

---

## 4. Los motores deterministas

Todos en `packages/domain`. Funciones puras, sin I/O, 175 pruebas.

| Motor | Archivo | Responsabilidad |
|---|---|---|
| Ordering | `ordering.ts` | APPLY / DUPLICATE / OUT_OF_ORDER por celda |
| Effective ARI | `effective-ari.ts` | External + Managed → Effective, provenance campo a campo |
| Sellability | `sellability.ts` | 9 predicados, cada uno con evidencia, dueño y remediación |
| Promotions | `promotions.ts` | DSL de elegibilidad + descuento + orden de apilamiento |
| Pricing | `pricing.ts` | El pipeline fijo de dinero |
| FX | `fx.ts` | Montos supplier / normalized / buyer, nunca colapsados |
| Offer integrity | `offer-signature.ts` | HMAC + TTL |
| Policy | `policy.ts` | Permisos × autonomía × límites numéricos |
| Simulation | `simulation.ts` | Blast radius, diff, frase de confirmación |
| Intent grammar | `intent-grammar.ts` | ES/EN → StructuredCommand, determinísticamente |
| Diagnostics | `diagnostics.ts` | El embudo de "¿por qué no estoy vendiendo?" |
| Revenue | `revenue.ts` | Ocupación/ADR/RevPAR, pace, valor neto por partner, hallazgos |
| Content | `content.ts` | Merge de perfil estratificado, completitud, licencia de imagen |
| Distribution | `distribution.ts` | Elegibilidad marketplace/geo/partner, decisión de crédito |
| Demand | `demand.ts` | Impresiones por comprador, flujo emisivo y receptivo |
| Permissions | `permissions.ts` | Resolución `rol + grants − revokes`, delegación, último admin |
| Groups | `groups.ts` | Capacidad bajo dos restricciones, gratuidad, evaluación de oferta, reloj |
| Event space | `eventspace.ts` | Aforo por montaje, unidad de tarifa más barata, pipeline de cotización |
| Resilience | `resilience.ts` | Token bucket, circuit breaker, bulkhead, backoff |

### El pipeline de precio (fijo, en este orden)

```
BASE → OCCUPANCY → PROMOTION → CONTRACT_MARKUP → CONTRACT_COMMISSION
     → TAX → FEE → FX → ROUNDING
```

Cada paso emite una línea con su entrada, su salida y su explicación. Un hotel
puede preguntar "¿por qué esta tarifa es 137,50?" y obtener la aritmética.

### Los 9 predicados de sellability

`PROPERTY_APPROVED`, `PROPERTY_OPEN`, `ARI_FRESH`, `AVAILABILITY_POSITIVE`,
`RESTRICTIONS_SATISFIED`, `MAPPING_COMPLETE`, `CONTRACT_VALID`,
`DISTRIBUTION_ALLOWED`, `PRICE_VALID`.

**Sin cortocircuito.** Los nueve se evalúan siempre, y un predicado sin
insumos reporta `evaluated: false` en vez de `false`. La diferencia entre "no
cumple" y "no se pudo saber" es la diferencia entre arreglar el problema
correcto y perseguir el equivocado.

---

## 5. Modelo de datos completo

45 modelos. Postgres 17, Prisma 6.

### Identidad y catálogo

| Modelo | Notas |
|---|---|
| `Tenant` | Raíz de aislamiento. `tenantId` en toda llave, query, log y caché |
| `Organization` | `PLATFORM \| CHAIN \| HOTEL \| AGENCY \| WHOLESALER \| OTA \| CORPORATE` |
| `User` | Rol, `grants[]`, `revokes[]`, `propertyIds[]`, `maxAutonomy`, `status` |
| `Property` | Estado de aprobación separado de la vendibilidad |
| `RoomType` | Código, aforo, cantidad física |
| `RatePlan` | Plan de comidas, moneda, reembolsable, DSL de cancelación |
| `TaxRule` | `PERCENTAGE \| FIXED_PER_NIGHT \| FIXED_PER_STAY`, incluido o no |

### Contenido (estratificado como ARI)

| Modelo | Notas |
|---|---|
| `PropertyContent` | Una fila por capa (`EXTERNAL`/`MANAGED`) por locale |
| `PropertyImage` | Con crédito y licencia. Sin ellos, se retiene de publicación |
| `ContentSource` | Booking, Expedia, GIATA, Gimmonix — con `certified` y `redistributionPermitted` |

### Distribución y partners

| Modelo | Notas |
|---|---|
| `DistributionPolicy` | `MARKETPLACE \| GEO \| PARTNER_EXCLUSIVE \| CLOSED` |
| `PartnerProfile` | Código único, identificación tributaria, términos de pago, línea de crédito |
| `CreditEntry` | Append-only. `HOLD \| RELEASE \| CHARGE \| PAYMENT \| ADJUSTMENT` |
| `SearchImpression` | Una por propiedad por búsqueda, con el predicado que bloqueó |

### Conectividad

| Modelo | Notas |
|---|---|
| `Connection` | Proveedor, modo `PUSH\|PULL\|BOTH`, referencia a bóveda de credenciales |
| `MappingVersion` | Versionado y publicado. Un mapeo incompleto bloquea la venta |
| `MappingEntry` | Código remoto → id local, por entidad |
| `RawEnvelope` | El payload crudo tal como llegó, para verificación de firma |

### ARI

| Modelo | Notas |
|---|---|
| `AriEvent` | El ledger. Append-only. `RATE \| AVAILABILITY \| RESTRICTION \| FULL_SYNC` |
| `AriCell` | Estado por celda por capa, con `lastPayloadHash` y `sourceSequence` |
| `EffectiveAri` | La proyección calculada, con provenance por campo |

### Comercial

| Modelo | Notas |
|---|---|
| `Contract` / `ContractVersion` | `NET \| COMMISSION \| MARKUP`, con permisos de reventa |
| `Promotion` / `PromotionVersion` | 18 tipos de regla. Código reutilizable tras cancelación |
| `SearchRequest` / `Offer` | Oferta firmada con HMAC y TTL |
| `Booking` / `BookingAttempt` | `UNKNOWN` es estado de primera clase |

### Agente

| Modelo | Notas |
|---|---|
| `AgentSession` / `AgentMessage` | Hilo de conversación con streaming |
| `AgentAction` | Comando, simulación, decisión de política, resultado, rollback |
| `AgentPolicy` | Límites por tenant: % de tarifa, % de descuento, blast radius |

### Grupos y eventos

| Modelo | Notas |
|---|---|
| `GroupBlock` | Inventario declarado, con techo físico separado de las líneas |
| `GroupBlockLine` | Por `roomTypeId` × `Bedding`, con tarifa opcional |
| `GroupPolicy` | Mínimo, tarifa piso, ventana de respuesta, depósito, beneficios |
| `GroupRequest` | La negociación, con `expiresAt` y `inventoryStatus` |
| `GroupBid` | Append-only. Una fila por ronda, con su evaluación congelada |
| `Notification` | `PENDING \| SENT \| FAILED \| NOT_CONFIGURED` con su requisito |
| `EventSpace` | Aforo por montaje, tarifas por unidad, equipos y A&B |

### Plataforma

| Modelo | Notas |
|---|---|
| `AuditEvent` | Append-only. Actor, acción, antes, después, razón, correlationId |
| `OutboxEvent` | Outbox transaccional |
| `IdempotencyRecord` | La llave primaria de la base es el lock |
| `ReconciliationRun` / `Divergence` | Divergencias registradas, nunca auto-corregidas |

---

## 6. ARI: el modelo canónico

### Llave de celda

```
tenant / property / room_type / rate_plan / stay_date / occupancy / layer
```

La llave de partición para procesamiento ordenado es `property:room:rate`. El
orden se garantiza dentro de una partición, y habitaciones distintas procesan
en paralelo.

### Capas

| Capa | Origen | Regla |
|---|---|---|
| **EXTERNAL** | Channel manager / supplier | Inmutable por evento. Nunca sobrescrita por un humano |
| **MANAGED** | Usuario o agente | Coexiste con External. Exige actor, razón y ventana de validez |
| **Contractual** | Contrato / promoción | Se aplica al construir la oferta — **nunca se escribe al ledger** |
| **Effective** | Calculada | Proyección determinística de External + Managed |

Un override managed gana **campo a campo**, y solo mientras su ventana de
validez cubra la fecha de estadía. Al vencer, el valor externo reaparece solo:
sin job de limpieza, sin deriva.

**La frescura se mide contra la capa EXTERNAL únicamente.** Un override humano
nunca debe hacer que un feed muerto parezca vivo.

### Idempotencia y orden

Tres mecanismos, cada uno para un fallo distinto:

1. **Hash del payload resultante** (`canonicalAriValues`) — un full sync
   reenviado idéntico es un no-op, incluso si llega por otro camino.
2. **`sourceSequence`** — un evento que llega fuera de orden se marca
   `OUT_OF_ORDER` y no retrocede el estado.
3. **Un DUPLICATE es prueba de vida** — un channel manager que republica cada 5
   minutos está *confirmando* vigencia, así que `receivedAt` se actualiza sin
   subir de versión, y solo lo `changed` publica `EffectiveARIChanged`.

---

## 7. Conectividad: adaptadores y resiliencia

### El contrato de adaptador

```ts
interface ChannelManagerAdapter {
  provider: Provider;
  capabilities: AdapterCapabilities;   // por operación, declaradas honestamente
  rateLimit: RateLimitSpec;
  parsePush(raw): CanonicalAriEvent[]; // pura, testeable contra fixtures
  pull(ctx, window): PullResult;
  pushAri(ctx, commands): PushResult;
  createBooking(ctx, cmd): SupplierBooking;
  cancelBooking(ctx, ref): void;
  healthCheck(ctx): HealthSnapshot;
  verifySignature(raw, headers): boolean;
}
```

### La suite de conformidad

`runConformance(adapter)` corre 11 verificaciones. **Una conexión cuyo
adaptador no reporta `certified: true` no puede habilitarse.** Un stub que
devuelve resultados vacíos es cómo un hotel termina "conectado" a un proveedor
que jamás envió un byte.

Adaptadores registrados:

| Adaptador | Estado |
|---|---|
| `mock-cm` | Certificado. Determinístico por `noiseFor(key, seed)` — reproducible |
| `canonical-json` | Certificado. El dialecto canónico de Wetriip |
| `pending` | SiteMinder, Dingus, Cloudbeds, DerbySoft — **no certificados**, fallan con `NOT_IMPLEMENTED` y sus requisitos pendientes |

### Resiliencia por conexión

Cada conexión tiene su propio **TokenBucket**, **CircuitBreaker** y
**Bulkhead**. Un proveedor limitando no consume los slots de otro. Un circuito
abierto se reporta como `CIRCUIT_OPEN`, no como un resultado vacío.

### Pull programado

`PullScheduler` toma un **lease** por conexión con expiración, guardado en la
columna de checkpoint. Dos workers no pueden avanzar el mismo checkpoint. Una
conexión que falla nunca aborta el loop de las demás.

---

## 8. Búsqueda, precio y ofertas

```
búsqueda ─► distribución ─► sellability ─► contrato ─► precio ─► FX ─► firma
              (primero)      (9 predicados)
```

**La distribución se evalúa antes que todo lo demás.** Un hotel cerrado a un
mercado nunca debe llegar al punto de tener una tarifa calculada.

Cada propiedad excluida reporta **qué predicado la bloqueó**, no desaparece en
silencio. La respuesta trae `offers[]` y `excluded[]`, y la segunda es la que
resuelve el ticket de soporte.

### Integridad de la oferta

Cada oferta lleva firma HMAC sobre su contenido canónico y un TTL. Al reservar
se re-verifica: una oferta manipulada devuelve `OFFER_TAMPERED`, una vencida
`OFFER_EXPIRED`. El precio que vio el comprador es el precio que se cobra, o la
reserva no procede.

### Moneda

`supplierAmount` / `normalizedAmount` / `buyerAmount` se preservan por separado
con la tasa y su origen. Nunca se colapsan en un solo número: un hotel que
factura en COP y una agencia que compra en USD tienen que poder reconciliar.

---

## 9. Reservas: la saga

```
claim idempotency key ─► verify offer ─► credit check ─► supplier call
                                                              │
                              ┌───────────────┬───────────────┤
                          CONFIRMED       REJECTED        UNKNOWN
                              │               │               │
                        credit HOLD      credit RELEASE   reconcile
```

**`UNKNOWN` es estado de primera clase.** Un timeout del proveedor no es un
rechazo: puede haber creado la reserva. Devolver `REJECTED` sería una mentira
que la saga no puede detectar después.

**La llave de idempotencia se reclama antes del efecto externo**, no después.
Reclamarla después deja la ventana en la que un reintento crea una segunda
reserva.

---

## 10. Grupos y salones

### Bloqueos: dos restricciones, no una

Un bloqueo declara máximos **por acomodación** y un **techo físico**. Las mismas
veinte habitaciones se arman twin *o* doble, así que las líneas legítimamente
suman por encima del techo. Ambas se verifican; confundirlas es el sobrecupo
clásico de grupos.

La disponibilidad se **deriva de las solicitudes vivas**, nunca se guarda como
contador. Un contador que hay que mantener es un contador que se desincroniza.

### La gratuidad

`computeGroupBenefits` otorga una unidad por cada N habitaciones **pagadas** —
21 con regla de 1×20 dan una, no una y fracción — y declara si la base es por
estadía o por noche.

El número que importa es `netAdr`:

> Quince habitaciones a 100 con una gratis **no son 100 por habitación.**

La habitación gratuita ocupa noches que no se facturan, así que el mismo dinero
se reparte entre más noches. El motor calcula ambas cifras y muestra la
diferencia.

### La negociación

La agencia llega con un **presupuesto**. `evaluateBid` lo convierte a valor por
habitación-noche, lo compara contra la tarifa piso y, si no alcanza, declara el
faltante **en dinero**. Tanto el faltante como el total del piso salen del
dinero crudo, nunca del ADR redondeado.

Las rondas son append-only. El vencimiento se calcula una vez desde la ventana
de respuesta del hotel y se guarda en la fila: el conteo que ve el hotel y el
plazo que aplica el barredor son el mismo valor.

**Una oferta viva retiene inventario dentro del bloqueo** para que dos agencias
no reciban un sí sobre las mismas veinte habitaciones. Al **aceptar**, la propia
retención de esa solicitud se excluye del recálculo — contarla en su contra
impide aceptar cualquier grupo una vez el bloqueo está ajustado.

### El descuento real de inventario

Cuando un grupo se acepta, las habitaciones salen de la venta:

1. Se calculan las **noches ocupadas** — check-in 10 y check-out 13 ocupan 10,
   11 y 12. La fecha de salida es de otro.
2. Cada acomodación se mapea a su `roomTypeId` y se **suman por tipo**: diez
   doble y cinco twin del mismo tipo son quince habitaciones de una sola bolsa.
3. Se escribe un decremento **en la capa MANAGED** sobre cada celda de ese tipo
   para esas noches, en todos los planes tarifarios — que es como un channel
   manager espeja disponibilidad.
4. Se **empuja hacia afuera** al channel manager por el adaptador. Si el push
   falla, nuestro Effective ARI ya está correcto (Wetriip no sobrevende), pero
   las OTAs siguen viendo el número viejo — así que se registra y se muestra.
5. Si la bolsa publicada no alcanza, el **faltante se cuenta y se reporta**. Un
   bloqueo promete veinte y el channel manager publicó dos: redondear a cero en
   silencio escondería exactamente el sobrecupo que esto existe para evitar.

Correr como **sistema**, no como la persona que aceptó: el decremento no es una
escritura discrecional, es la consecuencia mecánica del compromiso. Exigir
`availability.write` para aceptar significaría que alguien puede comprometer las
habitaciones pero no retirarlas.

Aceptar y decrementar viven en dos servicios y no pueden ser una transacción.
En vez de fingir, la solicitud carga `inventoryStatus`: `APPLIED` con el conteo
de celdas, o `FAILED` con la razón — visible en la consola, reintentable a mano
y reintentado por el barredor. **Un grupo aceptado cuyas habitaciones siguen a
la venta es el estado más peligroso del dominio**, y la consola lo grita.

Un grupo sin bloqueo **no puede aceptarse**: sin bloqueo no se sabe de qué tipo
de habitación salen las camas, y comprometer habitaciones que nadie puede
retirar es peor que rechazar.

### Salones

```
SPACE → SETUP → EQUIPMENT → CATERING → TAX
```

- **Aforo por montaje**: auditorio, escuela, en U, en L, junta, imperial,
  banquete, cóctel, cabaré. Cotizar 80 personas en U se **rechaza** nombrando el
  montaje que sí las tomaría.
- **Gana la unidad más barata que aplique**, y la cotización declara qué comparó.
- **Equipos y A&B separados**, porque son decisiones distintas.
- **Lo incluido se lista en cero**, no se esconde.
- El impuesto sale de las `TaxRule` de la propiedad, no de una constante.

---

## 11. El Agent Control Plane

### Los 19 comandos

**Lectura (9)** — ejecutan inmediato, no cambian nada:
`explain_no_sales`, `get_availability`, `get_ari_health`,
`get_connectivity_health`, `list_promotions`, `get_revenue_advisory`,
`get_partner_production`, `list_group_requests`, `get_event_spaces`.

**Escritura (10)** — simulan, evalúan política, esperan confirmación:
`create_promotion`, `update_promotion`, `set_promotion_status`, `update_rates`,
`update_availability`, `update_restriction`, `set_group_policy`,
`upsert_event_space`, `respond_group_request`, `rollback_action`.

### Niveles de autonomía

| Nivel | Nombre | Comportamiento |
|---|---|---|
| 1 | Observe | Lee y explica. Escrituras rechazadas de plano |
| 2 | Recommend | Propone cualquier escritura permitida; un humano confirma |
| 3 | Execute | Puede actuar sobre riesgo LOW/MEDIUM sin preguntar |

Autonomía efectiva = `min(user.maxAutonomy, techo de plataforma)`.

**HIGH risk siempre se detiene y exige step-up**, sea cual sea el nivel:
movimiento de tarifa sobre el límite, descuento sobre el límite, blast radius
sobre el límite, cerrar inventario, poner disponibilidad en cero, rollback, y
responder a una agencia por un grupo.

### El chat

20 herramientas. La única de escritura es `propose_change`, y **no ejecuta**:
valida el `StructuredCommand`, lo simula contra inventario vivo, evalúa política
y devuelve una propuesta con su blast radius. Un humano presiona Confirmar.

Voz de entrada (push-to-talk) y de salida usan el motor del navegador — ningún
audio sale de la máquina.

### La gramática determinista

`parseIntent` (español + inglés) no es un fallback: es una posición de diseño.
La plataforma debe poder correr, probarse y certificarse **sin un modelo en el
lazo**, porque el modelo es la única parte de la cadena que no se puede probar
contra una respuesta fija. Cuando hay LLM configurado produce el mismo tipo
`StructuredCommand` y pasa por la misma ruta de política, simulación,
confirmación y auditoría. La gramática es además el arnés de regresión contra
el que se mide el LLM.

### Rollback

El inverso se deriva de los valores "antes" registrados por la simulación, y usa
`SET` en vez del delta opuesto: revertir un +10% con un −10% no vuelve al número
original. Un rollback escribe una **versión nueva**; no borra nada.

Comandos sin inverso lo declaran con su razón: responder a una agencia no se
puede retirar una vez la agencia fue avisada, y la configuración no es un cambio
de inventario que revertir.

---

## 12. Identidad, roles y permisos

**El permiso es la unidad de autoridad; el rol es un paquete con nombre.**

```
efectivo = ROLE_PERMISSIONS[rol]  +  grants  −  revokes
```

La revocación es última e incondicional. Se resuelve **una sola vez, en el
gateway**, al iniciar sesión, y viaja en el contexto.

### 34 permisos

Lectura: `property.read`, `content.read`, `rates.read`, `promotions.read`,
`contracts.read`, `distribution.read`, `connectivity.read`, `groups.read`,
`events.read`, `bookings.read`, `partners.read`, `analytics.read`,
`audit.read`, `users.read`.

Escritura: `property.write`, `property.approve`, `content.write`,
`rates.write`, `availability.write`, `restrictions.write`, `promotions.write`,
`contracts.write`, `contracts.publish`, `distribution.write`,
`connectivity.manage`, `connectivity.sync`, `groups.write`, `groups.negotiate`,
`events.write`, `bookings.cancel`, `partners.write`, `partners.credit`,
`users.manage`.

Agente: `agent.use`, `agent.execute`, `agent.rollback`.

Plataforma: `platform.tenants.read`, `platform.activity.read`,
`platform.impersonate.read`.

### 10 roles

| Rol | Hace | No puede |
|---|---|---|
| `GENERAL_MANAGER` | Administra el equipo + autoridad comercial completa | — |
| `HOTEL_OWNER` | Como el GM, más aprobar la propiedad | — |
| `REVENUE_MANAGER` | Tarifas, disponibilidad, restricciones, promociones, distribución, grupos, salones | Administrar usuarios, publicar contratos |
| `ECOMMERCE` | Lee todo, analiza, **propone** por el asistente | Escribir cualquier cosa, confirmar |
| `RESERVATION_AGENT` | Reservas y cupos del día | Tocar precio |
| `FINANCE` | Crédito de mayoristas, facturación, producción | Tocar inventario |
| `CONNECTIVITY_ADMIN` | Channel managers, mapeos, salud | Tocar términos comerciales |
| `AGENCY_ADMIN` | El lado comprador, incluida la negociación de grupos | Responder sus propias solicitudes |
| `SUPPORT` | Personal Wetriip. Lee todo, no cambia nada | Escribir |
| `SUPER_ADMIN` | Administrador de plataforma. Todo | — |

### Tres ejes independientes

- **Rol** — *qué* puede hacer.
- **Alcance por propiedad** (`propertyIds`) — *dónde*. Vacío = todas.
- **Autonomía (L1–L3)** — hasta dónde llega el asistente antes de que un humano
  confirme.

Alguien puede tener `rates.write` en L1: puede cambiar tarifas, el agente solo
puede proponerlas.

### Límites de delegación

`assertCanAssign` rechaza tres cosas, y cada una cierra un camino real desde una
cuenta de gerente comprometida hasta toda la plataforma:

- asignar `SUPER_ADMIN` o `SUPPORT` — el personal Wetriip lo crea Wetriip;
- otorgar cualquier `PLATFORM_ONLY_PERMISSIONS`;
- otorgar un permiso que el actor no tiene.

`assertNotLastAdministrator` impide deshabilitar o degradar al último
administrador activo. Un hotel bloqueado fuera de su propia extranet es un
incidente que nadie puede resolver desde adentro.

### Deshabilitado, no borrado

Quien sale queda `status: DISABLED`. La cuenta sigue resolviendo para la
bitácora — su nombre tiene que renderizar contra los cambios que hizo — pero
`assertCan` devuelve falso para todo permiso y `login()` rechaza antes de emitir
sesión.

---

## 13. API pública completa

Todo bajo `/api/v1`. El gateway es el **único** componente expuesto; los
servicios internos viven en `/internal/*` y no son ruteables desde afuera.

### Sesión
```
POST /auth/login                    → { token, claims }
GET  /me                            → identidad + permisos + alcance
```

### Home y catálogo
```
GET  /overview                      → oportunidades + secciones degradadas
GET  /properties
GET  /properties/:id/workspace      → vista compuesta (allSettled)
GET  /properties/:id/calendar       ?from&to
GET  /properties/:id/ledger         ?limit
GET  /properties/:id/diagnose       → embudo de "¿por qué no vendo?"
POST /properties/:id/approve        [property.approve]
```

### Contenido
```
GET  /properties/:id/content        ?locale
POST /properties/:id/content        [content.write]
POST /properties/:id/content/images [content.write]
POST /properties/:id/content/images/:imageId/remove  [content.write]
GET  /properties/:id/content/sources
POST /properties/:id/content/import [content.write]
```

### Distribución, partners y demanda
```
GET  /properties/:id/distribution
POST /properties/:id/distribution   [distribution.write]
GET  /properties/:id/distribution/reach
GET  /properties/:id/demand         ?days
GET  /travel-flow                   ?direction&anchor&days
GET  /partners
POST /partners                      [partners.write]
GET  /partners/:organizationId/credit
GET  /properties/:id/partners
GET  /properties/:id/revenue        [analytics.read]
```

### Conectividad
```
GET  /connectivity/health           ?propertyId
GET  /connectivity/providers
POST /connectivity/providers/:provider/conformance
POST /connectivity/connections/:id/pull          [connectivity.sync]
POST /connectivity/connections/:id/health-check  [connectivity.sync]
```

### Grupos
```
GET  /groups/blocks                 ?propertyId          [groups.read]
POST /groups/blocks                                      [groups.write]
GET  /groups/policy/:propertyId                          [groups.read]
POST /groups/policy                                      [groups.write]
GET  /groups/requests               ?propertyId&status&mine  [groups.read]
GET  /groups/requests/:id                                [groups.read]
POST /groups/requests                                    [groups.negotiate]
POST /groups/requests/respond                            [groups.negotiate] +step-up
POST /groups/requests/:id/withdraw                       [groups.negotiate]
POST /groups/requests/:id/release-inventory              [groups.negotiate]
GET  /groups/notifications          ?requestId           [groups.read]
GET  /groups/notifications/capabilities                  [groups.read]
```

### Salones
```
GET  /event-spaces                  ?propertyId          [events.read]
POST /event-spaces                                       [events.write]
POST /event-spaces/quote                                 [events.read]
```

### Usuarios y administración de plataforma
```
GET  /users/catalog
GET  /users                                              [users.read]
POST /users                                              [users.manage]
POST /users/:id/status                                   [users.manage]
GET  /admin/tenants                                      [platform.tenants.read]
GET  /admin/users                                        [platform.impersonate.read]
GET  /admin/activity                ?limit               [platform.activity.read]
```

### Comercio
```
GET  /promotions                    ?propertyId
GET  /contracts
POST /search                        → ofertas firmadas + excluidos con causa
POST /bookings                      → saga idempotente
GET  /bookings                      ?propertyId
```

### Agente
```
POST /agent/chat/stream             → SSE                [agent.use]
GET  /agent/chat/sessions
GET  /agent/chat/sessions/:id
GET  /agent/capabilities
POST /agent/ask                     → propuesta con simulación
POST /agent/actions/:id/confirm                          [agent.execute] +step-up
POST /agent/actions/:id/reject
POST /agent/actions/:id/rollback                         [agent.rollback]
GET  /agent/actions                 ?limit
```

### Operación
```
POST /reconciliation/run                                 [connectivity.sync]
GET  /reconciliation/runs
GET  /audit                         ?limit&resourceType   [audit.read]
```

### Forma del error

Una sola forma para toda la plataforma:

```json
{
  "error": {
    "code": "POLICY_DENIED",
    "message": "…",
    "owner": "Revenue",
    "remediation": "…",
    "details": {},
    "correlationId": "cid_…"
  }
}
```

Códigos: `VALIDATION`, `PERMISSION`, `STALE_VERSION`, `CONFLICT`, `NOT_FOUND`,
`INCOMPLETE_MAPPING`, `DEPENDENCY_UNAVAILABLE`, `RATE_LIMITED`, `CIRCUIT_OPEN`,
`POLICY_DENIED`, `CONFIRMATION_REQUIRED`, `STEP_UP_REQUIRED`,
`IDEMPOTENCY_MISMATCH`, `OFFER_EXPIRED`, `OFFER_TAMPERED`, `NOT_IMPLEMENTED`,
`INTERNAL`.

Nunca se devuelve un stack trace ni un mensaje de Prisma: filtran detalles de
esquema y se leen como ruido.

---

## 14. El front end

Vite + React 18 + TypeScript. Sin framework de UI: 6.463 líneas propias.

| Archivo | Qué es |
|---|---|
| `App.tsx` | Navegación, sesión, montaje de vistas. Oculta lo que el usuario no puede alcanzar |
| `Brand.tsx` | Isotipo, wordmark y lockup en SVG. Los puntos de las dos íes caídas son las tapas redondas |
| `CommandCenter.tsx` | El chat completo: hilo, streaming, tarjetas, voz |
| `Copilot.tsx` | El asistente lateral en las demás vistas |
| `pages.tsx` | Overview, Properties, Property workspace, Connectivity, Distribution, Audit |
| `property-extra.tsx` | Perfil, imágenes, fuentes, partners, crédito |
| `groups.tsx` | Solicitudes, bloqueos, política — con el reloj y el estado de inventario |
| `events.tsx` | Salones y el cotizador |
| `users.tsx` | Equipo, matriz de permisos, administración de plataforma |
| `markdown.tsx` | Render de markdown del asistente |
| `voice.ts` | Web Speech API, entrada y salida |
| `api.ts` | Cliente con caché de última copia buena |
| `styles.css` | Sistema de diseño completo |

### Marca

Magenta `#EC4899` es identidad, **nunca** estado funcional. Las acciones
primarias son verdes o midnight. Sin degradados. Tres pesos de General Sans. La
consola no renderiza ni un botón magenta.

---

## 15. Observabilidad y errores

Cuatro capas, porque cada una responde una pregunta distinta y mezclarlas es
cómo un incidente toma horas en vez de minutos:

| Capa | Pregunta | Métricas |
|---|---|---|
| Conexión | ¿Podemos hablar con el partner? | auth ok, latencia, rate-limited, estado del circuito |
| Ingesta | ¿Qué recibimos y aceptamos? | recibidos, aceptados, rechazados, duplicados, fuera de orden |
| Effective | ¿Qué quedó vendible? | celdas stale, ratio vendible, latencia de materialización |
| Comercial | ¿Qué buscó y compró el comprador? | latencia de búsqueda, ofertas, excluidos, resultado de reserva |

Percentiles, no promedios — p50/p95/p99. Toda línea de log lleva un
correlationId que sigue un cambio desde el webhook del proveedor hasta la
búsqueda del comprador.

### SLOs (en `contracts/topology.ts`)

| Indicador | Objetivo | Ventana |
|---|---|---|
| ARI push materializado | 99% < 60 s | 30 días |
| Disponibilidad de búsqueda | 99,95% | 30 días |
| Latencia de búsqueda p95 | < 800 ms | 7 días |
| Resultado de reserva determinado | 99,9% < 2 min | 30 días |
| Reservas duplicadas | 0 | siempre |

### Reconciliación

```
SOURCE  ≈  LEDGER  ≈  EFFECTIVE  ≈  DISTRIBUTION
```

Tipos de divergencia: `MISSING_EFFECTIVE`, `PRICE_MISMATCH`,
`AVAILABILITY_MISMATCH`, `STALE_EFFECTIVE`, `OFFER_UNBACKED`.

Las divergencias se **registran, nunca se auto-corrigen**. Arreglar un
descuadre en silencio destruye la evidencia necesaria para hallar la causa, y la
causa suele estar aguas arriba de nosotros. Una celda con override managed no es
una divergencia.

---

## 16. Resiliencia

### En el gateway

Las vistas compuestas usan `Promise.allSettled` y **nombran la sección
degradada**. Un servicio caído no apaga una pantalla que otros ocho podían
llenar. La excepción es el catálogo en el workspace de propiedad: sin él no hay
propiedad que renderizar, y falla con su causa real.

### En el navegador

La consola cachea los GET exitosos y sirve la última copia conocida **con su
edad** cuando la plataforma no responde. Solo caen a caché los fallos de
transporte y los 5xx: un 403 es el servidor respondiendo y debe llegar al
usuario sin alterar. **Las escrituras nunca caen a caché** — una acción que no
llegó al servidor tiene que fallar de frente.

### Entre servicios

TokenBucket, CircuitBreaker y Bulkhead por conexión. Backoff exponencial con
jitter. Lease por conexión en el scheduler de pull.

---

## 17. Cómo correrlo

```bash
npm install
```

```bash
npm run prisma:deploy && npm run seed
```

```bash
npm run dev
```

En otra terminal, poblar inventario por el pipeline real de conectividad:

```bash
npm run bootstrap:ari
```

Abrir <http://localhost:3100>. La consola cambia de forma según quién entra:

| Entrar como | Qué obtiene |
|---|---|
| `melisa@caribehotels.co` | Revenue manager — tarifas, disponibilidad, grupos, salones |
| `gerencia@caribehotels.co` | Gerente general — lo anterior más **Equipo** |
| `ecommerce@caribehotels.co` | E-commerce — lee y propone, no escribe |
| `gerencia@ctmenlinea.com.co` | Agencia — el lado comprador |
| `ops@wetriip.ai` | Personal Wetriip — agrega **Plataforma** |

### Verificar

```bash
npm test
```

```bash
node scripts/smoke.js
```

Variables de entorno relevantes:

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Postgres |
| `SESSION_SECRET` | Firma de sesión HMAC |
| `OFFER_SIGNING_SECRET` | Firma de ofertas |
| `ANTHROPIC_API_KEY` | Ruta LLM del chat. Sin ella corre la gramática determinista |
| `CONNECTIVITY_PULL_ENABLED` | Scheduler de pull |
| `GROUPS_EXPIRY_INTERVAL_MS` | Barredor de vencimientos de grupo |
| `SMTP_HOST` … `SMTP_FROM` | Correo. Sin ellas, las notificaciones quedan `NOT_CONFIGURED` |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN`, `WHATSAPP_TEMPLATE_GROUP_REQUEST` | WhatsApp Business |
| `BODY_LIMIT`, `ARI_INGEST_CHUNK` | Ingesta de payloads grandes |

---

## 18. Qué es real y qué no

### Real, corriendo y verificado

Todo lo descrito arriba. 175 pruebas unitarias y 102 verificaciones end-to-end
contra servidor vivo, corridas tres veces seguidas para probar que no hay
intermitencia.

### Integraciones que son legales antes que técnicas

Booking.com, Expedia, GIATA y Gimmonix están **registradas y no certificadas**.
El bloqueo es un acuerdo de partner y derechos de redistribución de imágenes, no
código. **No se implementa un scraper**: viola sus términos y expone al hotel
tanto como a nosotros. El adaptador se agrega cuando exista el acuerdo, y
`redistributionPermitted` se registra con honestidad porque decide si la
integración puede existir.

Lo mismo para SiteMinder, Dingus, Cloudbeds y DerbySoft: registrados, sin
certificar, fallan con `NOT_IMPLEMENTED` y sus requisitos pendientes.

### [NO CONSTRUIDO]

| Qué | Por qué |
|---|---|
| OIDC/JWKS en el gateway | La sesión HMAC tiene exactamente los claims que un IdP afirmaría. El cambio toca un archivo |
| mTLS entre servicios | Los internos no son ruteables desde afuera en esta etapa |
| Cifrado de PII a nivel campo | Pendiente de definición de alcance regulatorio |
| WAF, SBOM y firma en CI | Pendiente de pipeline |
| Transporte SMTP y WhatsApp | Faltan credenciales y aprobación de plantilla Meta |
| API pública de partners (`/api/partner/v1`) | Diferido y comunicado |
| Rutinas programadas del chat | Diferido y comunicado |
| Ruta LLM del chat ejercida | Compila y usa el mismo contrato de herramientas, pero **nunca se ha corrido contra un modelo vivo**: no hay `ANTHROPIC_API_KEY` configurada. Toda la verificación usó la gramática determinista |

### Una brecha conocida y decidida

Un bloqueo de grupo **no** reduce el inventario transitorio mientras la
negociación está viva. Solo al **aceptar** las habitaciones salen de la venta.
Una oferta que vence habría retenido habitaciones de la venta durante un día sin
razón, y eso cuesta más que el riesgo que evita.
