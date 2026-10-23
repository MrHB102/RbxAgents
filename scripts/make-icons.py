"""Render the application's geometric logo as PNG and Windows ICO assets."""
from pathlib import Path
from math import radians, sin, cos
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / "resources"
image = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((48, 48, 976, 976), radius=224, fill="#bd93f9")

def square(half, color):
    angle = radians(-18)
    points = [(512 + x * cos(angle) - y * sin(angle), 512 + x * sin(angle) + y * cos(angle)) for x, y in [(-half, -half), (half, -half), (half, half), (-half, half)]]
    draw.polygon(points, fill=color)

square(257, "#282a36")
square(90, "#bd93f9")
image.resize((512, 512), Image.Resampling.LANCZOS).save(root / "icon.png")
image.save(root / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("Created resources/icon.png and resources/icon.ico")
