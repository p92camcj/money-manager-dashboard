# CLAUDE.md

Guía de referencia para trabajar en este repositorio. Léela antes de tocar código.

## Qué es este proyecto

Dashboard web local para **Money Manager** (app Android de finanzas personales, de Realbyte).
La app Android expone un servidor HTTP embebido llamado **"PC Manager"** cuando se activa desde
Ajustes > PC Manager, siempre en la misma red WiFi que el móvil (sin nube, sin cuentas externas).

Este proyecto es una interfaz web propia (Flask + HTML/JS estático) que:
- Actúa como **proxy/backend** hacia ese servidor del móvil, evitando problemas de CORS y dando
  un dashboard más potente que la web nativa de Money Manager.
- Añade **conciliación bancaria semisupervisada**: subes un extracto Excel del banco y el sistema
  propone qué movimientos del banco corresponden a qué transacciones ya registradas en Money
  Manager, o cuáles faltan por registrar.
- Añade un **motor de presupuestos jerárquico** que cruza el presupuesto configurado en la app con
  el gasto real por categoría/subcategoría.

No hay base de datos propia: la fuente de verdad son siempre los datos que vive en el móvil,
consultados en caliente a través del proxy.

## Arquitectura

```
static/           Frontend estático servido directamente por Flask (sin build step)
  index.html       Estructura de la SPA (tabs: Dashboard, Transacciones, Presupuestos, Conciliación, Ajustes)
  script.js        Toda la lógica de UI: fetch a /api/..., render de tablas/gráficas, modal de edición
  js/analytics.js  Cálculos auxiliares de analítica para el dashboard
  style.css        Estilos (glassmorphism)

backend/
  __init__.py
  reconciliation.py   match_bank_transactions(): matching banco↔Money Manager con pandas
                       (ventana de días + importe con tolerancia de 1 céntimo + heurística de
                       texto). Ver "Convención de conciliación" más abajo — NUNCA escribe en el
                       móvil. `suggested_mm_ref` y `candidates[].id` son el `id` real (UUID) de
                       la transacción en Money Manager, NUNCA el índice posicional del DataFrame
                       interno — un bug detectado el 2026-07-18 usaba `best_match.name` /
                       `idx_cand` (posición) en vez del campo `id`, lo que rompía silenciosamente
                       "Ver Registro Asociado" y `confirmMatch` en el frontend. Si tocas esta
                       función, no reintroduzcas esa confusión entre posición e id real.
  budget_engine.py    BudgetEngine: construye el árbol jerárquico presupuesto vs. gasto real
                       por categoría/subcategoría, y calcula flujos de caja (ingreso/gasto/
                       transferencias) ignorando transferencias en el cómputo de presupuesto.

app.py             Flask app. Sirve static/, y expone:
  /                        -> static/index.html
  /api/proxy/<endpoint>    -> proxy genérico GET/POST hacia http://<phone_ip>:<phone_port>/<endpoint>
                              (p.ej. /api/proxy/moneyBook/getDataByPeriod). Convierte XML a JSON,
                              limpia JSON no estándar del móvil (comillas sueltas, comas finales).
  /api/analyze-excel       -> conciliación: recibe el Excel del banco, pide transacciones reales
                              al móvil en la misma ventana de fechas, llama a match_bank_transactions
  /api/budget-hierarchy    -> pide transacciones + resumen de presupuesto al móvil, llama a BudgetEngine
  /api/config              -> GET/POST de config.json (IP/puerto del móvil)
  /api/version             -> versión actual de la app (ver "Versionado")

reference/         Código JS del propio Money Manager PC Manager (descargado con
                    reference/download_mm.py desde el servidor del móvil). Es material de
                    referencia para entender la API real, NO código propio del proyecto.
                    No editar como si fuera nuestro.

samples/            Ficheros de ejemplo para pruebas locales. NO están versionados en git
                    (pueden contener datos financieros reales del usuario, ver .gitignore).
```

El frontend nunca llama directamente a la IP del móvil: siempre pasa por `/api/proxy/...` en
Flask, que es quien conoce la IP/puerto (ver siguiente sección).

## Configuración: `config.json`

```json
{"phone_ip": "192.168.5.248:8888", "phone_port": "8888"}
```

- Vive en la raíz, se lee/escribe con `get_config()` / `save_config()` en `app.py`.
- Editable desde la UI (tab Ajustes) vía `GET/POST /api/config`.
- **Nunca hardcodear la IP del móvil en código.** Todo acceso al móvil pasa por `get_phone_url()`,
  que lee `config.json`. Si necesitas la URL del móvil en un sitio nuevo, reutiliza esa función.
- Este fichero sí está versionado en git (solo contiene una IP local de LAN, no es sensible). Si
  algún día `config.json` empieza a guardar algo más sensible, hay que revisar si debe seguir
  versionado.

## La API real del móvil (PC Manager) — referencia estable

Esta es la parte más frágil del proyecto: no la controlamos nosotros, es la API interna que
Realbyte expone en el móvil. Lo documentado aquí está verificado contra `reference/moneybook.js`
(JS original del PC Manager) y contra las pruebas reales en `test_post.py` / `check_post.py` /
`static/script.js`. Si cambia el comportamiento observado, actualiza esta sección.

### Lectura: `GET /moneyBook/getDataByPeriod?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`

Devuelve **XML**, no JSON:

```xml
<dataset>
  <results>158</results>
  <row>
    <id>uuid</id>
    <mbDate>2026-03-26</mbDate>
    <payType><![CDATA[🔴 Nómina Julio]]></payType>
    <inOutType>Gasto</inOutType>
    <mbCategory><![CDATA[❤️‍🩹 SALUD]]></mbCategory>
    <subCategory><![CDATA[...]]></subCategory>
    <mbContent><![CDATA[Amanda sesión 31]]></mbContent>
    <mbCash>60.0</mbCash>
    <assetId>...</assetId>
  </row>
</dataset>
```

`app.py:xml_to_dict()` lo convierte a lista de diccionarios. En **lectura**, `inOutType` viene en
español legible: `"Ingreso"`, `"Gasto"`, `"Transferencia"`.

### Lectura: `GET /moneyBook/getSummaryDataByPeriod?...` y `GET /moneyBook/getAssetData`

Devuelven JSON (a veces no estándar: claves sin comillas, comillas simples — de ahí
`clean_json()` en `app.py`). `getAssetData` da el árbol de cuentas/activos (grupo > cuentas, cada
una con `assetId`, `assetName`, `assetMoney`).

### Escritura: `POST /moneyBook/create`, `POST /moneyBook/update`, `POST /moneyBook/delete`

**`create`/`update` aceptan NOMBRES, no IDs, para `payType`, `mbCategory` y `subCategory`** — hay
que mandar el texto exacto tal cual aparece en Money Manager (incluyendo emojis), no un
identificador interno. Ejemplo real verificado (`test_post.py`):

```
mbDate:      2026-03-27T10:00:00
mbCash:      0.02
inOutType:   Egreso
inOutCode:   1
payType:     👛 Efectivo
mbCategory:  🍴 ALIMENTACIÓN
subCategory: 🍟 Restaurantes
mbContent:   texto libre
assetId:     11
```

`assetId` en cambio sí viaja como **ID real** (numérico o UUID, el mismo `assetId` que devuelve
`getAssetData`) — es la cuenta de origen. `payType` se manda en paralelo como el *nombre* de esa
misma cuenta (ver `getAssetName()` en `script.js`, que resuelve `assetId -> nombre` antes de
construir el payload). Para transferencias se usa además `targetAssetId` (ID de la cuenta destino).

**⚠️ Inconsistencia detectada entre `inOutType`/`inOutCode` de lectura y escritura — sin resolver:**

- En **lectura** (XML de `getDataByPeriod`), `inOutType` es `"Ingreso"` / `"Gasto"` / `"Transferencia"`.
- En **escritura** (`static/script.js:submitTransaction`), se traduce a otro vocabulario antes de
  mandarlo:
  ```js
  inOutTypeMap = {'Gasto': 'Egreso', 'Ingreso': 'Ingreso', 'Transferencia': 'Transfer'}
  inOutCodeMap = {'Gasto': '1', 'Ingreso': '2', 'Transferencia': '3'}
  ```
- Pero el propio JS original del móvil (`reference/moneybook.js`) usa códigos distintos al filtrar
  por pestaña: `inOutCode "0"` = Ingreso, `inOutCode "1"` = Gasto, y `"2"/"3"/"4"/"7"/"8"` para
  movimientos de activos/transferencias (varios códigos, no uno solo).
- No hay certeza de cuál mapeo es el correcto para `create`/`update` sin probarlo en vivo contra el
  móvil. Si tocas código de creación/edición de transacciones, **verifica contra el móvil real**
  antes de asumir que el mapeo actual de `script.js` es correcto, y actualiza esta sección con lo
  que confirmes.

`delete` espera `ids` con prefijo `:` — ejemplo: `ids=:<id_transaccion>`.

## Convención de conciliación bancaria: nunca auto-conciliar

**Regla dura: el backend nunca escribe automáticamente en el móvil como resultado de la
conciliación.** `match_bank_transactions()` solo genera *propuestas* (`status`: `exact_match`,
`probable_match`, `suggested_match`, `new`, con lista de `candidates` cuando hay ambigüedad). El
usuario siempre confirma manualmente en la UI antes de que cualquier cosa llegue a
`/moneyBook/create` o `/moneyBook/update`.

Esto es equivalente a la regla ya usada en GEMA para BGG: cuando hay **2 o más candidatos**
posibles para un mismo movimiento bancario, nunca se elige uno automáticamente — se presentan
todos y decide el usuario. Aquí aplica igual: un match con varios `candidates` no colapsa solo a
uno por mayor `confidence`; se muestran todos para que el usuario elija (o descarte).

Si en el futuro se añade cualquier tipo de "auto-aplicar" (aunque sea solo para `exact_match` con
un único candidato y confidence 100), debe ser explícito, opcional, y nunca el comportamiento por
defecto.

## Versionado

Formato `X.Y.Z.W`, constante `APP_VERSION` expuesta en `app.py` (o fichero `VERSION` en la raíz,
ambos deben coincidir — `app.py` lee `VERSION` como fuente única). Se expone en `GET /api/version`
y se muestra en el footer del frontend.

- **W** (build): nunca se incrementa a mano. Justo antes de un commit que vaya a quedar como
  entrega, ejecuta `git rev-list --count HEAD` y usa ese número literal como W.
- **Z** (patch): corrección o mejora interna sin funcionalidad nueva visible para el usuario.
- **Y** (minor): funcionalidad nueva visible para el usuario. Al subir Y, reinicia Z a 0.
- **X** (major): nunca se sube salvo petición explícita del usuario.
- Ante cualquier duda sobre si un cambio es X/Y/Z, preguntar antes de decidir — no asumir.

Cada tarea cerrada con cambios de código añade una entrada a `CHANGELOG.md` con versión, fecha y
qué cambió, y su propio commit (no se amontonan varias tareas en un commit).

## Comandos

### Entorno

```bash
python -m venv venv
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

pip install -r requirements.txt
```

### Arrancar la app

```bash
python app.py            # arranca Flask en http://localhost:5000, debug=True
```

O usando el lanzador de doble clic (ver `launch.py`, `launch.bat`, `launch.command`): comprueba
conexión con el móvil antes de arrancar Flask y abre el navegador automáticamente.

### Scripts de prueba contra el móvil

Requieren que el móvil esté en la misma WiFi con PC Manager activo, y la IP correcta en
`config.json` (o hardcodeada temporalmente en el propio script de prueba, nunca en `app.py`).

```bash
python test_post.py          # crea una transacción de prueba directamente contra el móvil
python check_post.py         # verifica que esa transacción de prueba se guardó
python test_nonexistent.py   # comprueba el comportamiento del servidor ante un endpoint inexistente
python reference/download_mm.py   # re-descarga el JS del PC Manager a reference/all_mm.js
```

Estos scripts pegan a la IP del móvil directamente (no pasan por Flask) — son para depurar la API
real, no para probar el backend propio.
