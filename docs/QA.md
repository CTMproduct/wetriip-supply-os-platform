# Wetriip Supply Extranet OS — preguntas y respuestas

Las preguntas que hacen un CTO, un hotel, una agencia, un inversionista y un
ingeniero nuevo. Incluidas las incómodas. Cada respuesta está anclada en código
que existe y corre; donde algo no está construido, se dice.

**Estado al 13 de agosto de 2026:** 37.127 líneas de TypeScript · 9 servicios ·
45 modelos · 39 permisos · 19 comandos · 215 pruebas unitarias (14 suites) ·
113 verificaciones end-to-end · 10 ADR.

---

## I. La tesis

### 1. ¿Qué es esto en una frase?

Una capa operativa programable entre la oferta hotelera y la demanda global,
donde la IA es la interfaz del sistema operativo — no el sistema.

### 2. ¿Por qué otro extranet? Ya existen veinte.

Los extranets existentes resuelven *cargar* tarifas. No resuelven las tres cosas
en las que un equipo comercial de hotel realmente gasta la semana:

1. **"¿Por qué no estoy vendiendo?"** — hoy se responde con un dashboard que
   muestra que no vendes, no *por qué*.
2. **Grupos** — se negocian por correo y WhatsApp, y la gratuidad se calcula mal.
3. **Salones** — se cotizan en Excel, y el aforo por montaje no está en ningún
   sistema.

Ninguna de las tres es un problema de UI. Las tres son problemas de modelo de
datos, y por eso no se resuelven con otro dashboard.

### 3. ¿Cuál es el moat? "IA para hoteles" lo copia cualquiera.

Correcto: el LLM no es el moat. Cualquiera conecta un modelo a unas tools en dos
semanas.

Lo difícil es que **"sube mi tarifa de fin de semana 8%, pero nunca por debajo
de paridad, y no toques el plan corporativo"** se convierta en:

- un comando determinístico,
- una simulación reproducible,
- una decisión de política explicable,
- un cambio auditable y reversible.

Eso son 20 motores puros, un ledger append-only, un modelo de permisos con
alcance por propiedad y un plano de control que se niega a ejecutar lo que no
puede explicar. Eso es lo que toma años, no el prompt.

### 4. ¿A quién le sirve primero?

Al **revenue manager** de un hotel independiente o una cadena pequeña en
Latinoamérica, que vende a mayoristas y agencias, y que hoy no tiene forma de
saber por qué una mayorista lo buscó 2.400 veces y no le compró.

---

## II. El límite del LLM

### 5. ¿Qué puede y qué no puede hacer el modelo?

**Puede:** entender lo que el usuario quiere decir, en español o inglés, por voz
o texto, y expresarlo como un valor de una unión cerrada de **19 comandos**.

**No puede:** modificar inventario, precio, contratos ni reservas. Su única
salida permitida es un `StructuredCommand`. Nada fuera de esa unión puede
expresarse, así que nada fuera de esa unión puede ocurrir.

La regla, textual, en la primera línea de `CLAUDE.md`:

> El LLM puede decidir qué **significa** el usuario. Nunca puede decidir qué le
> está **permitido**, qué estado es **verdadero**, ni si un efecto secundario
> **tuvo éxito**.

### 6. Si alguien hace jailbreak al modelo, ¿puede cambiar una tarifa?

No, y la razón no es que el prompt lo prohíba.

Un modelo comprometido produce, en el mejor de los casos, un `StructuredCommand`
válido. Ese comando pasa por: validación Zod → simulación contra inventario vivo
→ motor de política con los permisos **del usuario que preguntó** → confirmación
humana → ejecución solo en la capa MANAGED → auditoría.

Un analista de e-commerce puede pedirle al asistente que suba tarifas 40%. El
modelo construye el comando con gusto. Se rechaza en el check `PERMISSION`
porque esa persona no tiene `rates.write`. **Ese rechazo es el producto.**

### 7. Descubrimos que las herramientas del chat no verificaban permisos. ¿Cómo pasó?

Pasó, y es el hallazgo más importante del review externo. `ChatToolsService.run()`
despachaba por nombre de herramienta sin verificar nada; el gateway solo exigía
`agent.use` para abrir el chat. Un agente de reservas sin `analytics.read` podía
pedir el revenue advisory y obtenerlo.

El prompt sí le decía al modelo que no lo hiciera. **Un prompt no es una frontera
de seguridad.** Ahora cada herramienta declara su permiso en `TOOL_AUTHORITY` y
hay un solo punto de enforcement antes del switch; una herramienta sin entrada se
rechaza en vez de pasar sin control.

### 8. ¿Qué pasa si no hay API key?

La plataforma corre igual. Hay una **gramática determinista** (español + inglés)
que produce el mismo `StructuredCommand` y pasa por la misma ruta de política,
simulación, confirmación y auditoría.

No es un fallback: es una posición de diseño. La plataforma tiene que poder
correr, probarse y certificarse **sin un modelo en el lazo**, porque el modelo es
la única parte de la cadena que no se puede probar contra una respuesta fija. La
gramática es además el arnés de regresión contra el que se mide el LLM.

### 9. ¿La ruta LLM ya se probó contra un modelo real?

**No.** Compila y usa el mismo contrato de herramientas, pero nunca ha corrido
contra un modelo vivo porque no hay `ANTHROPIC_API_KEY` configurada. **Las 113
verificaciones end-to-end usan la gramática determinista.**

Es la limitación más importante del proyecto y no se debe minimizar: el día que
se conecte un modelo hará falta una suite de evals adversariales antes de darle
acceso a un tenant real.

### 10. ¿Por qué el prompt listaba 10 comandos si existen 19?

Porque nadie los comparaba. El lenguaje de comandos estaba definido en dos
lugares y se separaron en silencio — el modelo tenía prohibido la mitad de la
plataforma sin que nadie lo notara.

Ahora `renderCommandCatalog()` genera la lista desde `StructuredCommandSchema` y
una prueba afirma que cada tipo aparece. **El lenguaje de comandos se define en
exactamente un lugar.**

---

## III. Arquitectura

### 11. ¿Nueve servicios no es prematuro para una plataforma sin usuarios?

Es la crítica más justa que recibió el proyecto, y la respuesta tiene dos partes.

**El corte es correcto** y sigue aislamiento de fallos, no tablas: connectivity
habla con N proveedores hostiles y no puede tumbar search; booking es bajo
volumen y criticidad máxima; agent tiene la latencia y el costo de un LLM;
groups mide su trabajo en horas, no milisegundos.

**El despliegue no tiene que seguir el corte.** `services/all-in-one` levanta los
nueve módulos en un proceso, con las mismas rutas y las mismas llamadas HTTP
entre ellos. Fronteras lógicas ≠ microservicios físicos obligatorios. Hoy se
despliega como uno y se parte cuando las métricas lo justifiquen.

### 12. ¿Cómo evitan el monolito distribuido?

Con propiedad estricta de tablas. Un servicio lee y escribe **solo su agregado**
y alcanza otros dominios por API o evento, **nunca por join**. El mapa está
documentado en `packages/persistence/src/index.ts` y se revisa.

Esa restricción es lo que convierte el split posterior a bases separadas en un
cambio de configuración y no en una reescritura.

### 13. Si un servicio se cae, ¿qué ve el usuario?

Ve el resto de la pantalla, con la sección faltante **nombrada**.

Las vistas compuestas del gateway usan `Promise.allSettled`. Un servicio muerto
degrada su sección; no apaga una pantalla que otros ocho podían llenar. La
excepción deliberada es el catálogo en el workspace de propiedad: sin él no hay
propiedad que renderizar, y falla con su causa real.

La consola además cachea los GET exitosos y sirve la última copia conocida **con
su edad**. Con una excepción crítica: **la identidad nunca sale de caché.** Una
tarifa vieja con su edad encima es útil; una identidad vieja es una mentira.

### 14. ¿Por qué una sola base de datos?

Porque en etapa 1 el costo operativo de nueve bases supera el beneficio, y la
propiedad estricta de tablas hace que la separación sea un cambio de
configuración cuando llegue el momento.

### 15. ¿Por qué Zod y no class-validator?

Un solo validador, una sola fuente de verdad, y las mismas reglas llegue la
petición por HTTP o desde otro servicio. El `ValidationPipe` global se eliminó a
propósito: la validación vive en la frontera del dominio con los esquemas que los
servicios comparten.

---

## IV. ARI — el corazón del modelo

### 16. ¿Qué es ARI y por qué es un ledger?

Availability, Rates, Inventory. Es un **ledger append-only**: sin update, sin
delete, sin reescritura de estado.

Porque la pregunta que un hotel hace no es "¿cuál es la tarifa?" sino "¿por qué
la tarifa es 137,50 y quién la puso ahí?". Eso solo se responde si nada se
sobrescribe.

### 17. ¿Por qué separar EXTERNAL de MANAGED?

Porque son dos verdades distintas que deben poder coexistir.

**EXTERNAL** es lo que dijo el channel manager. **MANAGED** es lo que decidió una
persona, con actor, razón y ventana de validez. Un override managed gana **campo
a campo**, y solo mientras su ventana cubra la fecha. Al vencer, el valor externo
reaparece solo: sin job de limpieza, sin deriva.

Consecuencia crítica: **la frescura se mide contra EXTERNAL únicamente.** Un
override humano nunca debe hacer que un feed muerto parezca vivo.

### 18. ¿Qué pasa si los eventos llegan fuera de orden?

Se marcan `OUT_OF_ORDER` y no retroceden el estado. El orden se garantiza dentro
de una partición (`property:room:rate`) y habitaciones distintas procesan en
paralelo.

### 19. ¿Y si el mismo full sync llega dos veces?

Se hashea el **estado resultante** (`canonicalAriValues`), no el payload, así que
un reenvío idéntico es un no-op aunque llegue por otro camino.

Pero hay un matiz que costó encontrar: **un duplicado es prueba de vida.** Un
channel manager que republica cada 5 minutos está *confirmando* vigencia. Así que
un DUPLICATE actualiza `receivedAt` sin subir de versión, y solo lo que cambió
publica `EffectiveARIChanged`. Antes, un reenvío marcaba el inventario como
obsoleto — exactamente al revés de lo que significaba.

---

## V. Vender

### 20. ¿Por qué nueve predicados de vendibilidad sin cortocircuito?

Porque "no cumple" y "no se pudo saber" mandan a arreglar problemas distintos.

Los nueve se evalúan siempre, y un predicado sin insumos reporta
`evaluated: false`, no `false`. Cada propiedad excluida de una búsqueda reporta
**qué predicado la bloqueó**; no desaparece en silencio.

### 21. ¿Por qué "¿por qué no estoy vendiendo?" es el producto insignia?

Porque es la pregunta que nadie responde. La respuesta que esta plataforma da:

```
Recibiste 1.842 búsquedas.
713 fallaron porque el ARI estaba obsoleto.
392 las bloqueó tu regla de distribución solo-Colombia.
281 se perdieron por precio.
194 no tenían mapeo.
172 produjeron oferta.
90 convirtieron.

Tu acción de mayor valor: arreglar el mapeo Deluxe / BAR.
```

Eso no es un dashboard. Es un diagnóstico con un dueño y una remediación.

### 22. ¿Cómo se explica un precio?

Con un pipeline fijo que emite su propia aritmética:

```
BASE → OCCUPANCY → PROMOTION → CONTRACT_MARKUP → CONTRACT_COMMISSION
     → TAX → FEE → FX → ROUNDING
```

Cada paso emite una línea con su entrada, su salida y su explicación.

Regla asociada: **los ajustes contractuales y promocionales nunca entran al
ledger ARI.** Pertenecen a la construcción de la oferta. Meterlos al ledger es
cómo un hotel termina sin poder distinguir su tarifa de la comisión de una
agencia.

### 23. ¿Qué impide que se manipule una oferta?

Cada oferta lleva firma HMAC sobre su contenido canónico y un TTL. Al reservar se
re-verifica: manipulada devuelve `OFFER_TAMPERED`, vencida `OFFER_EXPIRED`. El
precio que vio el comprador es el que se cobra, o la reserva no procede.

---

## VI. Dinero

### 24. ¿Qué pasa si el proveedor no responde al reservar?

La reserva queda en `UNKNOWN`, que es un **estado de primera clase**.

Un timeout no es un rechazo: pudo haber creado la reserva. Devolver `REJECTED`
sería una mentira que la saga no puede detectar después. La llave de idempotencia
se reclama **antes** del efecto externo, no después — reclamarla después deja la
ventana donde un reintento crea una segunda reserva.

### 25. ¿Y si no se puede verificar el crédito?

Se rechaza la reserva.

Antes hacía `.catch(() => null)` y continuaba — un servicio de crédito caído
dejaba pasar todas las reservas, y lo primero que alguien sabría sería una
mayorista decenas de miles por encima de su límite. **Crédito desconocido no es
crédito aprobado.**

Si el hold de crédito falla *después* de que el proveedor confirmó, la reserva
queda marcada `HOLD_FAILED` con entrada de auditoría, porque es exposición real
que el ledger no conoce.

### 26. ¿Las llaves de idempotencia son seguras entre clientes?

Ahora sí. Eran globalmente únicas y el lock era `booking:<key>`. Las llaves suelen
derivarse de una referencia de PMS o una fecha, así que dos empresas sin relación
colisionaban y una recibía en silencio el resultado de la otra. Ahora van
namespaced: `tenant:<id>:<scope>:<key>`.

---

## VII. Grupos y salones

### 27. ¿Por qué un grupo no es una reserva grande?

Tres cosas son estructuralmente distintas:

1. **El inventario se declara, no se observa.** El hotel dice "aparto 20
   habitaciones", que es una decisión comercial que el channel manager desconoce.
2. **El precio se negocia, no se publica.** La agencia llega con un presupuesto,
   no con una búsqueda.
3. **Los términos son aritmética contractual.** "Una gratuidad por cada 20" es un
   cálculo que ambas partes deben poder reproducir meses después.

### 28. ¿Qué tiene de difícil un bloqueo de habitaciones?

Que tiene **dos restricciones, no una**. Las mismas veinte habitaciones se arman
twin *o* doble, así que un bloqueo de 20 legítimamente ofrece "hasta 18 twin" y
"hasta 20 doble" al mismo tiempo — y solo existen veinte. Confundir el máximo por
acomodación con el techo físico es el sobrecupo clásico de grupos.

Además la disponibilidad se **deriva de las solicitudes vivas**, nunca se guarda
como contador. Un contador que hay que mantener es un contador que se
desincroniza, y un contador de grupos desincronizado es un bloqueo vendido dos
veces.

### 29. ¿Cuál es el problema de la gratuidad?

Que casi todos la calculan mal. Quince habitaciones a 100 con una gratis **no son
100 por habitación**: la gratuita ocupa noches que no se facturan, así que el
mismo dinero se reparte entre más noches.

El motor calcula ambas cifras — ADR aparente y **ADR neto** — y mide la tarifa
piso contra la neta. Además otorga una unidad por cada N habitaciones **pagadas**,
así que 21 con regla de 1×20 dan una, no una y fracción.

### 30. ¿Aceptar un grupo saca las habitaciones de la venta?

Sí, y esa fue una corrección a una decisión mía equivocada. Un bloqueo que solo
existe dentro de Wetriip es un bloqueo que Booking.com sobrevende un martes.

Al aceptar: se calculan las noches ocupadas (check-in 10 y check-out 13 ocupan 10,
11 y 12 — la salida es de otro), se suman las camas por tipo de habitación, se
escribe el decremento en la capa **MANAGED** sobre cada plan tarifario, y se
**empuja al channel manager**.

Solo **aceptar** decrementa. Una negociación viva retiene dentro del bloqueo para
que dos agencias no reciban un sí, pero una oferta que vence no debe haber
retenido inventario real un día entero.

### 31. ¿Y si el bloqueo prometió más habitaciones de las que existen?

Se cuenta y se reporta el faltante. Un bloqueo promete veinte y el channel manager
publicó dos: redondear a cero en silencio escondería exactamente el sobrecupo que
esto existe para evitar. El hotel queda comprometido con habitaciones que su
propio feed no muestra, y la consola lo dice.

Aceptar y decrementar viven en dos servicios y no pueden ser una transacción. En
vez de fingir atomicidad, la solicitud carga `inventoryStatus`: `APPLIED` con el
conteo, o `FAILED` con la razón — visible, reintentable, y reintentado por el
barredor.

### 32. ¿Por qué un salón no es un tipo de habitación?

Porque se vende por **tiempo** o por **cabeza**, su aforo depende de cómo se
acomoden las sillas, y la mitad de su ingreso está en el videobeam y el coffee
break.

El aforo por montaje es el dato que carga el peso: la misma sala sienta 120 en
auditorio y 28 en U. Cotizar 80 personas en U se **rechaza** nombrando el montaje
que sí las tomaría. Descubrirlo la mañana del evento es la falla que esto evita.

---

## VIII. Identidad y permisos

### 33. ¿Cómo funcionan los permisos?

**El permiso es la unidad de autoridad; el rol es un paquete con nombre.**

```
efectivo = paquete del rol  +  grants  −  revokes
```

La revocación es última e incondicional: un gerente que quita algo no debe
encontrar que el rol se lo devuelve. Se resuelve **una sola vez, en el gateway**,
y viaja en el contexto.

Tres ejes **independientes**: el rol dice *qué*, el alcance por propiedad dice
*dónde*, y la autonomía L1–L3 dice hasta dónde llega el asistente antes de que un
humano confirme. Alguien puede tener `rates.write` en L1: puede cambiar tarifas,
el agente solo puede proponerlas.

### 34. ¿Por qué e-commerce puede usar el agente pero no ejecutar?

Porque así funciona el trabajo. El analista encuentra la oportunidad; alguien con
autoridad la firma.

Tiene `agent.use` pero no `agent.execute`. Puede pedirle al asistente que suba
tarifas, ver cómo parsea el comando, ver el blast radius simulado — y ver cómo se
rechaza por nombre. Quitarle `agent.use` sería más fácil de implementar y
borraría el puesto.

### 35. ¿Qué impide que un gerente general se escale a sí mismo?

Tres rechazos en `assertCanAssign`, y cada uno cierra un camino real desde una
cuenta comprometida hasta toda la plataforma:

- no puede asignar `SUPER_ADMIN` ni `SUPPORT` — el personal Wetriip lo crea
  Wetriip;
- no puede otorgar ningún `PLATFORM_ONLY_PERMISSIONS`;
- no puede otorgar un permiso que él mismo no tiene.

Y `assertNotLastAdministrator` impide deshabilitar o degradar al último
administrador activo: un hotel bloqueado fuera de su propia extranet es un
incidente que nadie puede resolver desde adentro.

### 36. ¿Cómo ve Wetriip todo sin que los hoteles se vean entre sí?

`platform.tenants.read`, `platform.activity.read` y `platform.impersonate.read`
no pertenecen a ningún rol de hotel y **no se pueden otorgar desde dentro de un
tenant**. La superficie es de solo lectura: ver lo que hizo un tenant es soporte;
actuar como él no lo es.

### 37. ¿Qué pasa cuando alguien se va del hotel?

Se **deshabilita, no se borra**. La bitácora tiene que seguir resolviendo su
nombre contra los cambios que hizo, pero `assertCan` devuelve falso para todo
permiso y `login()` rechaza antes de emitir sesión.

---

## IX. Seguridad — lo que el review externo encontró

### 38. ¿Qué estaba mal antes?

Un review externo calificó la arquitectura alto y la preparación para producción
en ~5/10, con una conclusión correcta: *"la idea es fuerte, la implementación no
está lista para producción con dinero, inventario y reservas reales"*.

Los hallazgos serios eran reales. Los más graves:

| Hueco | Qué permitía |
|---|---|
| Headers de identidad sin firmar | Cualquiera que alcanzara un puerto interno podía escribir `x-wetriip-role: SUPER_ADMIN` |
| Step-up como booleano | `x-wetriip-step-up: true` desbloqueaba toda acción de alto riesgo |
| Herramientas del chat sin permisos | Un agente de reservas alcanzaba analítica de revenue |
| Scope de propiedad ignorado | Un gerente limitado a dos hoteles veía todo el tenant |
| TOCTOU en confirmación | Se aprobaba +10% sobre 100 y se ejecutaba sobre 150 |
| Crédito fail-open | Servicio de crédito caído = todas las reservas pasan |
| Idempotencia global | Dos empresas colisionaban en la misma llave |

Los 18 hallazgos están en [ADR-010](adr/ADR-010-control-plane-hardening.md) con
qué permitía cada uno, porque un arreglo que nadie puede explicar es un arreglo
que alguien deshace.

### 39. ¿Qué es el step-up ahora?

Una **prueba firmada, de 5 minutos, ligada a UNA acción**. Nombra usuario,
tenant, acción y expiración. No se puede reusar contra otra acción, otro usuario,
otro tenant, ni cinco minutos después.

Donde no hay verificador real configurado, la prueba lo dice: `amr: ['dev']`,
nunca `['mfa']`. Nada aguas abajo puede confundir una prueba de desarrollo con un
segundo factor real.

### 40. ¿Qué era el problema TOCTOU y cómo se resolvió?

```
10:00  tarifa 100. La simulación de +10% proyecta 110. El humano ve 110.
10:03  el channel manager empuja 150.
10:05  el humano confirma. La ejecución relee 150 y aplica +10% → 165.
```

Nadie aprobó 165. El comando se ejecutó fielmente y el resultado era incorrecto,
porque un porcentaje es función del estado y el estado se movió.

Ahora una propuesta carga un **binding**: hashes del comando, del estado ARI, de
los números proyectados y de la autoridad del solicitante, más expiración de 15
minutos. La confirmación vuelve a tomar los cuatro y rechaza si alguno se movió,
**nombrando cuál** y mostrando la proyección vieja contra la nueva.

Congelar los números y aplicarlos a ciegas habría sido peor. El humano ve qué
cambió y decide otra vez.

### 41. ¿Ya está listo para producción?

**No.** Y el proceso ahora se niega a arrancar si alguien lo intenta.

`assertProductionPosture()` corre en cada bootstrap y **lanza excepción** con
`NODE_ENV=production` si falta OIDC, si un secreto es un placeholder conocido o
tiene menos de 32 caracteres, si la firma interna está deshabilitada, o si no hay
verificador de segundo factor. No es un warning en un log que nadie lee: es
salida distinta de cero con la lista de lo que falta.

---

## X. Límites honestos

### 42. ¿Qué NO está construido?

| Qué | Por qué |
|---|---|
| OIDC/JWKS real | El guard de producción convierte el riesgo silencioso en ruidoso, pero el intercambio sigue sin construirse |
| mTLS entre servicios | El contexto firmado cubre autoridad, no confidencialidad de transporte |
| Cifrado de PII a nivel campo | Pendiente de definición de alcance regulatorio |
| WAF, SBOM, firma en CI | Pendiente de pipeline |
| Transporte SMTP y WhatsApp | Faltan credenciales y aprobación de plantilla Meta |
| API pública de partners | Diferido y comunicado |
| Suite de evals adversariales | No hay sustituto, y la ruta LLM sigue sin correr contra un modelo vivo |

### 43. ¿Cuál es el riesgo abierto más grande?

**Las escrituras multi-celda de ARI siguen aplicándose celda por celda.**

La política permite hasta 5.000 celdas. El ejecutor itera secuencialmente. Un
fallo en la celda 2.720 deja las 2.719 anteriores cambiadas y la acción en
`FAILED` — y el rollback solo acepta acciones `EXECUTED`.

El límite de blast radius acota el daño; no lo elimina. Necesita un endpoint
batch y un modelo de execution job con reintento idempotente por operación. **Es
el P0 más grande que queda** y está nombrado como tal.

### 44. ¿Por qué Booking y Expedia no están integrados?

Porque el bloqueo es **legal antes que técnico**: hace falta un acuerdo de partner
y derechos de redistribución de imágenes.

Booking, Expedia, GIATA y Gimmonix están registrados y **no certificados**. Fallan
con `NOT_IMPLEMENTED` y sus requisitos pendientes, y reportan `ok: false`.

**No se implementa un scraper.** Viola sus términos y expone al hotel tanto como a
nosotros. El adaptador se agrega cuando exista el acuerdo, y
`redistributionPermitted` se registra con honestidad porque decide si la
integración puede existir.

Lo mismo para SiteMinder, Dingus, Cloudbeds y DerbySoft. Una conexión cuyo
adaptador no reporta `certified: true` no puede habilitarse: un stub que devuelve
resultados vacíos es cómo un hotel termina "conectado" a un proveedor que jamás
envió un byte.

### 45. ¿Qué harían en el próximo sprint?

**No agregar funcionalidad.** Terminar de endurecer el plano de control:

1. OIDC/JWKS real en el gateway.
2. Escrituras multi-celda atómicas con execution jobs.
3. La suite de evals adversariales — ~500 escenarios midiendo
   `cross_tenant_escape_rate = 0`, `unauthorized_tool_execution = 0`,
   `write_without_valid_proposal = 0`, `duplicate booking = 0`.

Esas no son métricas de precisión de IA. Son **invariantes de negocio**.

---

## XI. Operación

### 46. ¿Cómo lo corro?

```bash
npm install && npm run prisma:deploy && npm run seed && npm run dev
```

Y en otra terminal, poblar inventario por el pipeline real de conectividad:

```bash
npm run bootstrap:ari
```

`npm run dev` sirve el API **y** la consola en el puerto 3100. Si la consola carga
pero el acceso dice *"The platform is not responding"*, el API no está detrás de
esa dirección — el mensaje nombra cuál de los dos falta.

### 47. ¿Con qué usuario entro?

| Correo | Qué ve |
|---|---|
| `melisa@caribehotels.co` | Revenue manager |
| `gerencia@caribehotels.co` | Gerente general — agrega **Team** |
| `ecommerce@caribehotels.co` | E-commerce — lee y propone, no escribe |
| `gerencia@ctmenlinea.com.co` | Agencia — el lado comprador |
| `pipe@wetriip.ai` | Wetriip — agrega **Platform** |

El acceso por correo es un atajo de desarrollo: **no autentica a nadie.**

### 48. ¿Cómo verifico que funciona?

```bash
npm test
```

```bash
node scripts/smoke.js
```

215 pruebas unitarias y 113 verificaciones end-to-end contra servidor vivo. El
smoke es **repetible**: cada corrida crea su propio bloqueo de grupo y varía el
descuento de la promoción, porque un test que solo pasa la primera vez es un test
que miente.

### 49. ¿Cómo agrego un channel manager?

1. Una clase que implemente `ChannelManagerAdapter`.
2. Declarar capacidades **por operación** y límites de tasa honestamente.
3. Fixtures para `parsePush`; es puro, así que se prueba contra payloads grabados.
4. `runConformance(adapter)` debe reportar `certified: true`.
5. Registrarlo en `registry.provider.ts`.

### 50. ¿Cómo agrego un comando del agente?

Seis pasos, todos obligatorios: la forma en `StructuredCommandSchema`, la
gramática determinista **con pruebas**, la evaluación de riesgo, una rama de
simulación que produzca conteos reales, una rama de ejecución que escriba solo en
MANAGED, y un inverso para rollback — o la declaración explícita de que no se
puede revertir, con la razón.

`respond_group_request` es un ejemplo de lo último: no se puede retirar una
respuesta que la agencia ya recibió, así que la respuesta honesta es un rechazo
que nombra lo que sí puede arreglarlo.

---

## Una nota sobre este documento

Las respuestas incómodas están aquí a propósito: la ruta LLM sin probar, las
escrituras multi-celda no atómicas, OIDC sin construir, y los 18 huecos que un
review externo encontró — dos de ellos introducidos por el propio trabajo de
resiliencia de este proyecto.

Un Q&A que solo contiene las respuestas favorables no es documentación. Es
material de venta, y no sobrevive el primer contacto con alguien que lee el
código.
