"""Build assets/fonts/ from the catalogue (assets/fonts/fonts.json).

    python manage.py fonts_setup [--tol0 PATH] [--windows-fonts PATH] [--check]

For every file the catalogue names:
  * NimbusRoman-*.otf, NimbusSans-*.otf, NimbusMonoPS-*.otf — converted from
    tol0's certified bare CFFs (tol0/fonts/*.cff — the very outlines the OCR
    glyph sets were rendered from) into OpenType wrappers browsers and
    HarfBuzz accept. Needs fontTools.
  * cambria.ttf — the first face of Windows' cambria.ttc.
  * everything else — copied from the Windows font folder (case-insensitive
    lookup, e.g. CENSCBK.TTF → censcbk.ttf).

Files already present are left alone (delete one to rebuild it). --check
only reports what is missing and exits 1 if anything is. The Windows faces
are proprietary: the command copies them for local use the way the repo has
always shipped them; do not redistribute beyond that.
"""
import io
import os
import shutil
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from text_tool.logic import fonts


def cff_to_otf(src, dst, family, bold=False, italic=False):
    from fontTools.agl import toUnicode
    from fontTools.cffLib import CFFFontSet
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.boundsPen import BoundsPen
    from fontTools.ttLib import newTable

    with open(src, 'rb') as f:
        data = f.read()
    cff = CFFFontSet()
    cff.decompile(io.BytesIO(data), None)
    td = cff[0]
    order = list(td.charset)
    upm = int(round(1 / td.FontMatrix[0])) if getattr(td, 'FontMatrix', None) else 1000

    fb = FontBuilder(upm, isTTF=False)
    fb.setupGlyphOrder(order)
    cmap = {}
    for name in order:
        u = toUnicode(name)
        if len(u) == 1 and ord(u) not in cmap:
            cmap[ord(u)] = name
    fb.setupCharacterMap(cmap)

    metrics = {}
    for name in order:
        cs = td.CharStrings[name]
        pen = BoundsPen(None)
        cs.draw(pen)
        lsb = pen.bounds[0] if pen.bounds else 0
        metrics[name] = (int(round(cs.width)), int(round(lsb)))
    fb.setupHorizontalMetrics(metrics)

    table = newTable('CFF ')
    table.cff = cff
    fb.font['CFF '] = table

    bbox = getattr(td, 'FontBBox', [0, -200, 1000, 800])
    ascent, descent = int(bbox[3]), int(bbox[1])
    style = ' '.join(s for s, on in (('Bold', bold), ('Italic', italic)) if on) or 'Regular'
    ps = f"{family.replace(' ', '')}-{style.replace(' ', '')}"
    fb.setupHorizontalHeader(ascent=ascent, descent=descent)
    fb.setupNameTable({'familyName': family, 'styleName': style, 'psName': ps,
                       'fullName': f'{family} {style}', 'uniqueFontIdentifier': ps})
    fb.setupOS2(sTypoAscender=ascent, sTypoDescender=descent, sTypoLineGap=0,
                usWinAscent=ascent, usWinDescent=-descent,
                usWeightClass=700 if bold else 400,
                fsSelection=(0x20 if bold else 0) | (0x01 if italic else 0) | (0x40 if not (bold or italic) else 0))
    fb.setupPost()
    fb.font['head'].macStyle = (1 if bold else 0) | (2 if italic else 0)
    fb.save(str(dst))


class Command(BaseCommand):
    help = 'Build the font files the catalogue (assets/fonts/fonts.json) names'

    def add_arguments(self, parser):
        parser.add_argument('--tol0', default=str(Path(settings.BASE_DIR).parent / 'tol0'),
                            help='the tol0 repo (its fonts/*.cff are the URW sources)')
        parser.add_argument('--windows-fonts', default=os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts'))
        parser.add_argument('--check', action='store_true', help='report missing files only')

    def handle(self, *args, **opts):
        tol0 = Path(opts['tol0'])
        winfonts = Path(opts['windows_fonts'])
        win_index = {}
        if winfonts.is_dir():
            win_index = {p.name.lower(): p for p in winfonts.iterdir() if p.is_file()}
        fonts.FONT_DIR.mkdir(parents=True, exist_ok=True)

        built, present, missing = [], [], []
        for fam in fonts.families():
            for style, name in fam['files'].items():
                dst = fonts.FONT_DIR / name
                if dst.is_file():
                    present.append(name)
                    continue
                if opts['check']:
                    missing.append(name)
                    continue
                try:
                    if name.lower().endswith('.otf') and name.startswith('Nimbus'):
                        src = tol0 / 'fonts' / (name[:-4] + '.cff')
                        if not src.is_file():
                            raise FileNotFoundError(src)
                        cff_to_otf(src, dst, fam['family'], bold=style in ('bold', 'bolditalic'),
                                   italic=style in ('italic', 'bolditalic'))
                    elif name == 'cambria.ttf':
                        from fontTools.ttLib import TTCollection
                        ttc = win_index.get('cambria.ttc')
                        if not ttc:
                            raise FileNotFoundError('cambria.ttc')
                        TTCollection(str(ttc)).fonts[0].save(str(dst))
                    elif name == 'DejaVuSerif.ttf':
                        src = tol0 / 'fonts' / name
                        if not src.is_file():
                            src = win_index.get(name.lower())
                        if not src:
                            raise FileNotFoundError(name)
                        shutil.copyfile(src, dst)
                    else:
                        src = win_index.get(name.lower())
                        if not src:
                            raise FileNotFoundError(name)
                        shutil.copyfile(src, dst)
                    built.append(name)
                except Exception as e:  # one missing source must not stop the rest
                    missing.append(f'{name} ({e})')

        self.stdout.write(f'{len(present)} present, {len(built)} built, {len(missing)} missing')
        for n in built:
            self.stdout.write(f'  built   {n}')
        for n in missing:
            self.stdout.write(f'  MISSING {n}')
        if missing:
            raise CommandError('some catalogue files are missing — the toolbar falls back for those families')
