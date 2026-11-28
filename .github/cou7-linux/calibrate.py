import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
import time

import vision

parser = argparse.ArgumentParser()
parser.add_argument('positive')
parser.add_argument('negative')
parser.add_argument('output')
args = parser.parse_args()
magick = os.environ.get('COU7_MAGICK')
convert = [magick] if magick else ['convert']
tesseract = os.environ.get('COU7_TESSERACT', 'tesseract')
version = subprocess.run([tesseract, '--version'], check=True, text=True, capture_output=True).stdout.splitlines()[0]
sources = {'positive': pathlib.Path(args.positive), 'negative': pathlib.Path(args.negative)}
results = []
with tempfile.TemporaryDirectory(prefix='cou7-calibration-') as directory:
    temp = pathlib.Path(directory)
    rgb = {}
    for label, original in sources.items():
        for shape, size in [('zero', None), ('even-offset', '1440x1000'), ('odd-offset', '1441x1001')]:
            source = original
            if size:
                source = temp / f'{label}-{shape}-padded.png'
                subprocess.run(convert + ['-size', size, 'xc:white', str(original), '-geometry', '+220+100',
                                          '-composite', str(source)], check=True, capture_output=True)
            crop = temp / f'{label}-{shape}-crop.png'
            frame = vision.capture_image(str(source), str(crop), time.monotonic() + 45)
            expected_origin = (0, 0) if not size else (220, 100)
            assert (frame['left'], frame['top']) == expected_origin
            plan = vision.queue_plan(frame)
            emitted = []
            used = vision.emit_queue(frame, emitted.append)
            assert (plan is not None) == (label == 'positive')
            assert used == (label == 'positive')
            assert emitted == ([(expected_origin[0]+873, expected_origin[1]+319)] if label == 'positive' else [])
            if plan is not None:
                assert vision.dark(vision.pixel(frame['rgb'], *plan))
            results.append({'case': f'{label}-{shape}', 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                            'cropSha256': hashlib.sha256(crop.read_bytes()).hexdigest(),
                            'sourceSize': [frame['width'], frame['height']], 'cropOrigin': list(expected_origin),
                            'localPoint': list(plan) if plan else None, 'windowPoint': list(emitted[0]) if emitted else None,
                            'mockInputCount': len(emitted), 'queue': vision.queue_diagnostics(frame['lines'], frame['rgb'])})
            rgb[(label, shape)] = frame['rgb']
    assert rgb['positive', 'zero'] == rgb['positive', 'even-offset'] == rgb['positive', 'odd-offset']
    assert rgb['negative', 'zero'] == rgb['negative', 'even-offset'] == rgb['negative', 'odd-offset']
    frame = vision.capture_image(str(sources['positive']), str(temp / 'without-role.png'), time.monotonic() + 45)
    frame['lines'] = [(text, line) for text, line in frame['lines'] if 'fixture' not in text]
    assert vision.queue_plan(frame) == vision.QUEUE_CLICK
output = {'sourceRun': 'https://github.com/Ejupi-Labs/council-herdr/actions/runs/46174484283',
          'sourceArtifact': 'https://github.com/Ejupi-Labs/council-herdr/actions/runs/46174484283/artifacts/15274779547',
          'ocr': version + ' PSM 11', 'cases': results, 'negativeEmittedInput': False,
          'roleOcrRequiredForQueue': False,
          'limitation': 'Offline engine and ImageMagick can differ from the hosted Ubuntu build; the live frame is revalidated.'}
pathlib.Path(args.output).write_text(json.dumps(output, indent=2), encoding='utf-8')
print(json.dumps({'offlineCalibration': 'pass', 'cases': len(results), 'negativeEmittedInput': False}))
