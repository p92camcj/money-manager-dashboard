"""Auto-actualización del .exe empaquetado, vía GitHub Releases (ver Propuesta #6 en
BACKLOG.md). Solo se usa desde `desktop_app.py` -- la vía técnica (`git clone` + `launch.py`) se
actualiza con `git pull` (ver `check_for_updates()` en launch.py) y nunca pasa por aquí: no hay
repo git local en la máquina de un amigo, así que la fuente de verdad aquí es la API de GitHub
Releases, no el historial de git.

Patrón de auto-reemplazo en Windows: un proceso no puede sobreescribir su propio .exe mientras
se está ejecutando. La solución (sin dependencias de terceros ni un segundo ejecutable
compilado) es un script auxiliar que:
  1. espera a que el proceso actual termine,
  2. mueve el .exe nuevo -- ya descargado a un fichero `.new` junto al viejo -- sobre el .exe
     original,
  3. relanza el .exe (ya actualizado),
  4. se borra a sí mismo.

Cualquier fallo (sin internet, GitHub no responde, el Release no tiene el asset esperado...) se
registra y la función simplemente retorna -- nunca debe bloquear ni impedir el arranque normal
con la versión local.

**El script auxiliar es PowerShell, no un .bat/cmd.exe** -- decisión tomada tras varias rondas de
pruebas reales fallidas con cmd.exe (no elegida a priori): `timeout` dentro de un cmd.exe sin
consola real falla y retorna al instante en vez de esperar de verdad, rompiendo el ritmo de los
reintentos. Los cmdlets de PowerShell usados aquí (`Start-Sleep`, `Move-Item`, `Start-Process`)
no tienen esa dependencia.

**El proceso PowerShell se lanza con `CREATE_NO_WINDOW`, no `DETACHED_PROCESS`** -- también
decidido tras pruebas reales: con `DETACHED_PROCESS` el proceso auxiliar moría casi
inmediatamente, antes de completar siquiera el primer reintento (con o sin consola, entra en
juego además el propio bootloader de PyInstaller --onefile del proceso padre, que también
retiene el bloqueo del `.exe` más tiempo del esperado tras salir su proceso hijo -- de ahí que se
espere tanto al PID del proceso interno como al de su padre, ver más abajo). Con
`CREATE_NO_WINDOW` (consola oculta pero real, no ausente) el ayudante sí sobrevive con
normalidad; `Start-Process` para el relanzamiento final tampoco se ve afectado por heredar esa
consola oculta, a diferencia del `start` de cmd.exe.
"""
import os
import subprocess
import sys
import tempfile

import requests

GITHUB_REPO = "p92camcj/money-manager-dashboard"
RELEASES_API_URL = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
ASSET_NAME = "MoneyManagerDashboard.exe"
REQUEST_TIMEOUT = 5
DOWNLOAD_TIMEOUT = 60


def _version_tuple(v):
    return tuple(int(p) for p in v.strip().lstrip("v").split("."))


def check_for_update_and_restart(current_version, logger=None):
    """Si hay una versión más nueva publicada en GitHub Releases, la descarga y reinicia la app
    ya actualizada (la llamada no vuelve -- el proceso termina con sys.exit). Si no hay
    actualización, o la comprobación falla por cualquier motivo, retorna normalmente sin más.
    No hace nada si no se está ejecutando como .exe empaquetado (modo desarrollo)."""
    log_info = logger.info if logger else print
    log_error = logger.error if logger else print

    if not getattr(sys, "frozen", False):
        return  # `python desktop_app.py` en desarrollo -- no hay .exe que auto-reemplazar

    try:
        resp = requests.get(RELEASES_API_URL, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        release = resp.json()
        latest_version = str(release.get("tag_name", "")).lstrip("v")

        if not latest_version or _version_tuple(latest_version) <= _version_tuple(current_version):
            log_info(f"[updater] Versión al día ({current_version}).")
            return

        asset = next((a for a in release.get("assets", []) if a.get("name") == ASSET_NAME), None)
        if not asset:
            log_error(
                f"[updater] Hay una versión nueva ({latest_version}) pero el Release no tiene "
                f"el asset '{ASSET_NAME}' -- se omite la actualización."
            )
            return

        log_info(f"[updater] Descargando actualización {current_version} -> {latest_version} ...")
        current_exe = sys.executable
        new_exe_path = current_exe + ".new"
        with requests.get(asset["browser_download_url"], timeout=DOWNLOAD_TIMEOUT, stream=True) as dl_resp:
            dl_resp.raise_for_status()
            with open(new_exe_path, "wb") as f:
                for chunk in dl_resp.iter_content(chunk_size=1024 * 256):
                    f.write(chunk)

        log_info(f"[updater] Descarga completa. Reiniciando con la versión {latest_version}...")
        _spawn_replace_and_exit(current_exe, new_exe_path)
    except Exception as e:
        log_error(f"[updater] No se pudo comprobar/aplicar la actualización ({e}). Arrancando con la versión local.")


def _spawn_replace_and_exit(current_exe, new_exe_path):
    pid = os.getpid()
    # En un .exe --onefile de PyInstaller, os.getpid() es el PID del proceso interprete "interno"
    # -- pero el bootloader "externo" (el mismo nombre en el Administrador de tareas, PID
    # distinto, padre del anterior) es quien retiene más tiempo el bloqueo del propio fichero
    # .exe mientras limpia su carpeta de extracción temporal. Verificado en pruebas reales:
    # esperar solo a os.getpid() no bastaba. Se espera a que desaparezcan AMBOS PIDs.
    ppid = os.getppid()
    old_exe_path = current_exe + ".old"
    # Nombre único por invocación (no fijo): si una actualización anterior dejara un ayudante
    # todavía en marcha por cualquier motivo, no debe competir por el mismo fichero.
    ps1_path = os.path.join(tempfile.gettempdir(), f"mm_dashboard_update_{pid}.ps1")

    def _ps_quote(path):
        return "'" + path.replace("'", "''") + "'"

    ps_current = _ps_quote(current_exe)
    ps_old = _ps_quote(old_exe_path)
    ps_new = _ps_quote(new_exe_path)

    ps1_contents = f"""
# El propio proceso PowerShell se lanza con una consola real (ver mas abajo, CREATE_NEW_CONSOLE
# en vez de CREATE_NO_WINDOW/DETACHED_PROCESS -- verificado en pruebas reales que ambas
# alternativas dejaban morir o colgar el ayudante o el relanzamiento final) y la oculta ella
# misma nada mas arrancar -- normalmente imperceptible (bajo un segundo).
Add-Type -Name Window -Namespace ConsoleHide -MemberDefinition '
[DllImport("Kernel32.dll")]
public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")]
public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'
$hwnd = [ConsoleHide.Window]::GetConsoleWindow()
[ConsoleHide.Window]::ShowWindow($hwnd, 0) | Out-Null

foreach ($waitPid in @({pid}, {ppid})) {{
    while (Get-Process -Id $waitPid -ErrorAction SilentlyContinue) {{
        Start-Sleep -Seconds 1
    }}
}}

# Windows permite RENOMBRAR un .exe en ejecucion (los ejecutables se abren con
# FILE_SHARE_DELETE), pero NO sobreescribir su contenido en el mismo nombre mientras siga
# mapeado como imagen -- verificado en pruebas reales: mover el nuevo directamente sobre el
# viejo fallaba en silencio incluso despues de que ambos PIDs ya no existieran. El patron que
# si funciona de forma fiable: renombrar el viejo a un lado primero (deja el nombre libre),
# luego mover el nuevo a ese nombre ya vacio (una creacion normal, no una sustitucion de imagen
# mapeada). El retraso real hasta que esto funciona resulto, en pruebas reales, mucho mayor y
# mas variable de lo esperado (de segundos a varios minutos) -- no por un bloqueo del propio
# proceso (un rename manual sin ningun proceso vivo se completa al instante), sino con toda
# probabilidad por el analisis en tiempo real de Windows Defender sobre un .exe recien
# descargado, sin firma digital y nunca visto antes en esta maquina -- el mismo motivo por el
# que SmartScreen avisa en la descarga manual (ver README_AMIGOS.md). Se reintenta hasta 5
# minutos antes de rendirse; si aun asi sigue bloqueado, se continua igualmente con lo que haya
# en disco -- en el peor caso se relanza la version vieja, que volvera a intentar actualizarse
# en su proximo arranque.
$retries = 0
while ($retries -lt 300) {{
    try {{
        Move-Item -Path {ps_current} -Destination {ps_old} -Force -ErrorAction Stop
        break
    }} catch {{
        Start-Sleep -Seconds 1
        $retries++
    }}
}}

# El .exe recien descargado tambien puede estar retenido un rato (mismo motivo), asi que este
# segundo movimiento se reintenta igual que el anterior.
$retries2 = 0
while ($retries2 -lt 300) {{
    try {{
        Move-Item -Path {ps_new} -Destination {ps_current} -Force -ErrorAction Stop
        break
    }} catch {{
        Start-Sleep -Seconds 1
        $retries2++
    }}
}}

Start-Process -FilePath {ps_current}

# Best-effort: el .old puede seguir bloqueado un rato; si falla, no importa, es solo un residuo.
Remove-Item -Path {ps_old} -Force -ErrorAction SilentlyContinue
Remove-Item -Path $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
"""
    with open(ps1_path, "w", encoding="utf-8") as f:
        f.write(ps1_contents)

    # CREATE_NEW_CONSOLE: una consola nueva y real (visible un instante -- el propio script de
    # PowerShell se oculta a sí mismo nada más arrancar, ver arriba). Verificado en pruebas
    # reales que las dos alternativas más "limpias" fallaban: DETACHED_PROCESS dejaba morir el
    # ayudante casi de inmediato (probablemente por interacción con el propio bootloader de
    # PyInstaller --onefile del proceso padre), y CREATE_NO_WINDOW completaba el reemplazo del
    # .exe correctamente pero el `Start-Process` final que lo relanza se quedaba colgado a 0% CPU
    # sin llegar a arrancar Flask -- en ambos casos, con o sin ventana oculta, algo en la cadena
    # de herencia de consola quedaba roto. Dar una consola real y de verdad, y ocultarla desde
    # dentro, es el único de los tres enfoques que funcionó de principio a fin en pruebas reales.
    creationflags = subprocess.CREATE_NEW_CONSOLE
    subprocess.Popen(
        ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1_path],
        creationflags=creationflags,
        close_fds=True,
    )
    sys.exit(0)
