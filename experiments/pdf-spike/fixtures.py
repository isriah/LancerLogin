"""Generate only synthetic local evidence; requires Pillow, reportlab and pypdf."""
from pathlib import Path
from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter
import random

out = Path(__file__).parent / 'output'
out.mkdir(exist_ok=True)
for extension in ('png', 'jpeg'):
    im = Image.new('RGB', (1200, 800), '#edf4fa')
    draw = ImageDraw.Draw(im)
    draw.rectangle((100, 150, 520, 650), fill='#255b8a')
    draw.ellipse((630, 180, 1100, 650), fill='#eeac45')
    draw.text((100, 70), 'SYNTHETIC GEOMETRIC EVIDENCE - NO PERSONAL DATA', fill='black', font_size=27)
    im.save(out / f'geometry.{extension}')
rng = random.Random(84)
Image.frombytes('RGB', (1600, 1200), rng.randbytes(1600*1200*3)).save(out/'noise.jpeg',quality=90)
c = canvas.Canvas(str(out / 'source.pdf'), pagesize=(500, 700), invariant=1)
for n in range(1, 4):
    c.setFont('Helvetica', 24)
    c.drawString(45, 630, f'Synthetic source page {n}')
    c.setFillColorRGB(.1*n, .3, .6)
    c.rect(45, 130, 410, 400, fill=1)
    c.showPage()
c.save()
writer = PdfWriter()
writer.append(PdfReader(out / 'source.pdf'))
writer.encrypt('synthetic-fixture-only')
writer.write(out / 'encrypted.pdf')
(out / 'corrupt.pdf').write_bytes(b'%PDF-1.7\nmalformed synthetic fixture')
print('Synthetic fixtures generated in ignored output/')
