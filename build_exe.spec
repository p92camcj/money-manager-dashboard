# -*- mode: python ; coding: utf-8 -*-
# Genera el .exe de la distribución "amigable" para Windows (ver Propuesta #6 en BACKLOG.md y
# CLAUDE.md, sección "Distribución con ejecutable de Windows"). No afecta a la vía técnica
# (git clone + venv), que no usa este fichero para nada.
#
# --onefile (un único EXE) porque el objetivo explícito es "un único ejecutable, doble clic, sin
# instalar nada" para alguien sin conocimientos técnicos -- el arranque algo más lento de
# --onefile (tiene que autoextraerse a una carpeta temporal en cada arranque) es un precio
# aceptable frente a la simplicidad de un solo fichero que descargar y mover.
#
# static/, VERSION y NOVEDADES.md se empaquetan como datos de solo lectura (ver
# backend/paths.py:resource_dir()) -- backend/ NO hace falta listarlo aquí, PyInstaller sigue
# automáticamente los `import backend.xxx` de app.py y empaqueta ese código dentro del propio EXE.
# NOVEDADES.md (aviso de novedades tras auto-actualizar, ver CLAUDE.md) se lee en tiempo de
# ejecución desde app.py -- si falta en el .exe empaquetado, el aviso simplemente no tendría
# nada que mostrar (parse_novedades() ya tolera que el fichero no exista), pero no tiene sentido
# publicar el .exe sin él.

datas = [
    ('static', 'static'),
    ('VERSION', '.'),
    ('NOVEDADES.md', '.'),
]

# Icono propio del .exe (Propuesta #18, BACKLOG.md) -- antes no se pasaba ningún `icon=` a EXE()
# aquí abajo, así que PyInstaller usaba su icono por defecto (un disquete de 3.5", sin relación
# con lo que hace la app). static/app_icon.ico se genera con Pillow (ver generate_icon.py,
# reproducible con `python generate_icon.py`) a partir del propio degradado de colores de la UI
# (--primary/--secondary en style.css) -- una moneda de € sobre un gráfico de barras ascendente,
# para que se lea como "finanzas/conciliación bancaria" incluso en el tamaño pequeño del icono de
# la barra de tareas. No es un icono de terceros -- se generó desde cero para este proyecto, sin
# dudas de licencia.
ICON_PATH = 'static/app_icon.ico'

a = Analysis(
    ['desktop_app.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='MoneyManagerDashboard',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=ICON_PATH,
)
