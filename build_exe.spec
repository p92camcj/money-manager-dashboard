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
# static/ y VERSION se empaquetan como datos de solo lectura (ver backend/paths.py:resource_dir())
# -- backend/ NO hace falta listarlo aquí, PyInstaller sigue automáticamente los `import
# backend.xxx` de app.py y empaqueta ese código dentro del propio EXE.

datas = [
    ('static', 'static'),
    ('VERSION', '.'),
]

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
)
