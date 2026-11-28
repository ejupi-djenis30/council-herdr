import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import vision

positive, negative, output = map(pathlib.Path, sys.argv[1:])
magick = os.environ.get('COU7_MAGICK')
convert = [magick] if magick else ['convert']
tesseract = os.environ.get('COU7_TESSERACT', 'tesseract')
version = subprocess.run([tesseract, '--version'], check=True, text=True, capture_output=True).stdout.splitlines()[0]
results = []
with tempfile.TemporaryDirectory(prefix='cou7-handoff-replay-') as directory:
    temp = pathlib.Path(directory)
    for label, original in [('detail', positive), ('list', negative)]:
        for size, origin in [(None, (0, 0)), ('1440x1000', (220, 100)), ('1441x1001', (220, 100))]:
            source = original
            if size:
                source = temp / 'padded.png'
                subprocess.run(convert + ['-size', size, 'xc:white', str(original), '-geometry', '+220+100',
                                          '-composite', str(source)], check=True, capture_output=True)
            frame = vision.capture_image(str(source), str(temp / 'crop.png'), time.monotonic() + 45)
            emitted = []
            accepted = vision.emit_handoff(frame, emitted.append)
            assert (frame['left'], frame['top']) == origin
            assert accepted == (label == 'detail')
            local = vision.handoff_plan(frame)
            if accepted:
                x, y = local
                assert 354 < x < 503 and 334 < y < 364
                assert emitted == [(origin[0]+x, origin[1]+y)]
            else:
                assert not emitted
            results.append({'case': label, 'sourceSize': [frame['width'], frame['height']], 'origin': list(origin),
                            'localPoint': local, 'windowPoint': emitted[0] if emitted else None,
                            'mockInputCount': len(emitted)})
output.write_text(json.dumps({'sourceRun': 'https://github.com/Ejupi-Labs/council-herdr/actions/runs/46176589266',
                              'sourceSha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (positive, negative)},
                              'ocr': version + ' PSM 11', 'cases': results,
                              'limitation': 'Offline OCR differs from Ubuntu; no native input was emitted.'}, indent=2), encoding='utf-8')
print('handoff offline replay: six cases pass; list emitted no input')
