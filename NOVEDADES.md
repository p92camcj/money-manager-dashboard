# Novedades

Resumen en lenguaje sencillo de lo que ha cambiado en cada versión, pensado para cualquier
persona que use la aplicación (no solo quien programa). La versión técnica completa, con detalle
de qué archivo cambió y por qué, está en `CHANGELOG.md`.

## 0.13.3.50 - 2026-07-20

- Nuevo icono para la versión de escritorio (.exe): una moneda con gráfico de barras, en vez del
  disquete genérico de antes.

## 0.13.2.49 - 2026-07-20

- Arreglado: en la versión de escritorio (.exe) ya se puede seleccionar y copiar texto de la app
  (importes, conceptos, referencias) para pegarlo donde haga falta.

## 0.13.1.48 - 2026-07-20

- En "Enlazar manualmente", ahora puedes pulsar ✏️ junto a un movimiento de Money Manager para
  corregirlo (fecha, importe, categoría...) antes de confirmar el enlace, sin perder tu sitio.

## 0.13.0.47 - 2026-07-20

- Nuevo en Conciliación: botón "Deshacer última conciliación". Antes de deshacer nada te enseña
  qué se va a deshacer (fecha, importe, concepto) y te pide confirmación.

## 0.12.2.46 - 2026-07-20

- Arreglado: en "Enlazar manualmente", al elegir un movimiento del banco a veces algún movimiento
  de Money Manager que buscabas parecía desaparecer de la lista. Ya no -- solo se reordenan por
  parecido de importe, nunca desaparecen.

## 0.12.1.44 - 2026-07-20

- Nuevo en Conciliación: botón "Enlazar manualmente" para los casos que el emparejamiento
  automático no acierta (por ejemplo, un cargo de Amazon con concepto o fecha distintos entre el
  banco y Money Manager). Elige uno de cada lista y enlázalos a mano.

## 0.12.0.43 - 2026-07-20

- Nuevo buscador propio: pulsa Ctrl+F en cualquier momento y aparece una barra de búsqueda arriba
  a la derecha que filtra al instante lo que estés viendo (Transacciones, Conciliación o
  Presupuestos), sin distinguir mayúsculas ni acentos. Se cierra con Escape.

## 0.11.1.42 - 2026-07-20

- Arreglado: al abrir por primera vez el detalle de una transacción en una sesión, a veces la
  subcategoría aparecía vacía aunque la transacción sí tuviera una guardada. Ya carga bien siempre.

## 0.11.0.41 - 2026-07-20

- Nuevo "arqueo de caja" en Conciliación: además de comparar el extracto del banco contra Money
  Manager, ahora también avisa de los movimientos que están en Money Manager pero que no aparecen
  en el extracto que has subido (gastos en efectivo, duplicados, cuotas internas...). Se muestran
  en una sección aparte, con un resumen arriba de cuánto cuadra y cuánto falta por cada lado.

## 0.10.0.38 - 2026-07-19

- En Conciliación, el botón "Ver Registro Asociado" ya no te saca de la pantalla donde estabas
  revisando: ahora abre el movimiento en una ventanita, donde además puedes editarlo si hace
  falta. Al cerrarla, sigues justo donde te habías quedado (mismo scroll, mismo filtro).

## 0.9.2.36 - 2026-07-19

- Al confirmar manualmente cuál de varias propuestas de conciliación es la correcta, ahora se
  refleja al instante como "Ya Conciliado" (antes, en algunos casos, seguía viéndose como
  pendiente de revisar aunque ya se hubiera guardado la elección).

## 0.9.1.35 - 2026-07-19

- En la conciliación bancaria, los movimientos que ya coinciden perfectamente ahora se ven más
  discretos (no necesitas mirarlos), mientras que los que tienen dudas o son nuevos destacan más,
  para que sepas de un vistazo a cuáles prestar atención.

## 0.9.0.33 - 2026-07-19

- Al abrir la aplicación después de una actualización, ahora aparece un aviso con un resumen de
  las novedades desde la última vez que la abriste.
- Añadido un enlace "Ver novedades" abajo del todo para consultar el historial completo cuando
  quieras.

## 0.8.4.32 - 2026-07-19

- Si se pierde la conexión con el móvil a mitad de uso (por ejemplo, al analizar un extracto
  bancario), ahora la aplicación lo avisa claramente en vez de mostrar resultados como si todo
  hubiera ido bien.
- Al subir varios extractos bancarios a la vez, si dos de ellos contienen el mismo movimiento
  real (por ejemplo, una transferencia entre tus propias cuentas en dos bancos distintos), ahora
  se reconoce correctamente en ambos en vez de que uno "se quede" con el movimiento y el otro no
  lo encuentre.
