"""Genera static/app_icon.ico -- icono propio del .exe (Propuesta #18, BACKLOG.md), sin depender
de ningún recurso de terceros. Requiere Pillow (`pip install Pillow`), no incluido en
requirements.txt/requirements-desktop.txt porque solo hace falta para regenerar el icono, nunca
en tiempo de ejecución ni durante el build de PyInstaller (que solo referencia el .ico ya
generado, ver build_exe.spec).

Diseño: fondo cuadrado redondeado con el mismo degradado ya usado en la propia UI (--primary
#4169e1 -> --secondary #6c5ce7, ver static/style.css), una moneda dorada con el símbolo € dibujado
a mano (no depende de que una fuente concreta tenga el glifo "€" bien centrado en cada tamaño) y
un gráfico de barras ascendente detrás, aludiendo a la conciliación bancaria / finanzas personales
de la app -- pensado para leerse con claridad incluso en el icono pequeño de la barra de tareas.
"""
from PIL import Image, ImageDraw

SIZE = 256


def main():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # --- Fondo: cuadrado muy redondeado con degradado diagonal primary -> secondary ---
    c1 = (65, 105, 225)   # --primary
    c2 = (108, 92, 231)   # --secondary
    bg = Image.new("RGB", (SIZE, SIZE))
    bgpix = bg.load()
    for y in range(SIZE):
        for x in range(SIZE):
            t = (x + y) / (2 * SIZE)
            bgpix[x, y] = (
                int(c1[0] + (c2[0] - c1[0]) * t),
                int(c1[1] + (c2[1] - c1[1]) * t),
                int(c1[2] + (c2[2] - c1[2]) * t),
            )

    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=int(SIZE * 0.22), fill=255)
    img.paste(bg, (0, 0), mask)
    draw = ImageDraw.Draw(img)

    # --- Gráfico de barras ascendente, sutil, detrás de la moneda ---
    bar_color = (255, 255, 255, 55)
    bar_w = SIZE * 0.09
    bar_gap = SIZE * 0.04
    base_y = SIZE * 0.80
    start_x = SIZE * 0.10
    for i, h in enumerate([0.16, 0.24, 0.34, 0.46]):
        x0 = start_x + i * (bar_w + bar_gap)
        draw.rounded_rectangle([x0, base_y - SIZE * h, x0 + bar_w, base_y], radius=bar_w * 0.25, fill=bar_color)

    # --- Moneda dorada con símbolo € ---
    coin_cx, coin_cy = SIZE * 0.60, SIZE * 0.46
    coin_r = SIZE * 0.30
    gold_outer = (255, 209, 102, 255)
    gold_inner = (255, 190, 60, 255)
    gold_edge = (196, 140, 20, 255)

    draw.ellipse(
        [coin_cx - coin_r, coin_cy - coin_r, coin_cx + coin_r, coin_cy + coin_r],
        fill=gold_outer, outline=gold_edge, width=max(2, int(SIZE * 0.012)),
    )
    inner_r = coin_r * 0.82
    draw.ellipse(
        [coin_cx - inner_r, coin_cy - inner_r, coin_cx + inner_r, coin_cy + inner_r],
        outline=gold_inner, width=max(2, int(SIZE * 0.02)),
    )

    euro_color = (120, 74, 6, 255)
    lw = max(3, int(SIZE * 0.028))
    arc_r = coin_r * 0.5
    arc_box = [coin_cx - arc_r, coin_cy - arc_r * 1.05, coin_cx + arc_r * 0.55, coin_cy + arc_r * 1.05]
    draw.arc(arc_box, start=95, end=265, fill=euro_color, width=lw)
    by1 = coin_cy - arc_r * 0.32
    by2 = coin_cy + arc_r * 0.32
    bx0 = coin_cx - arc_r * 0.92
    bx1 = coin_cx + arc_r * 0.05
    draw.line([bx0, by1, bx1, by1], fill=euro_color, width=lw)
    draw.line([bx0, by2, bx1, by2], fill=euro_color, width=lw)

    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    img.save("static/app_icon.ico", format="ICO", sizes=sizes)
    print("Icono guardado en static/app_icon.ico")


if __name__ == "__main__":
    main()
