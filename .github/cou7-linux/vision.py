import csv
import os
import re
import subprocess
import time

CROP_WIDTH, CROP_HEIGHT = 1000, 800
QUEUE_SAMPLES = ((815, 311), (929, 311), (873, 319))
QUEUE_CLICK = (873, 319)

def crop_origin(width, height):
    if width < CROP_WIDTH or height < CROP_HEIGHT:
        raise RuntimeError('window frame is smaller than the calibrated crop')
    return (width - CROP_WIDTH) // 2, (height - CROP_HEIGHT) // 2

def window_point(frame, local):
    x, y = local
    if not (0 <= x < CROP_WIDTH and 0 <= y < CROP_HEIGHT):
        raise RuntimeError('point outside the calibrated crop')
    return frame['left'] + x, frame['top'] + y

def capture_image(raw, crop, deadline):
    magick = os.environ.get('COU7_MAGICK')
    identify = [magick, 'identify'] if magick else ['identify']
    convert = [magick] if magick else ['convert']
    tesseract = os.environ.get('COU7_TESSERACT', 'tesseract')
    def invoke(args, binary=False):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('image processing deadline')
        return subprocess.run(args, check=True, capture_output=True, text=not binary,
                              timeout=min(12, remaining)).stdout
    width, height = map(int, invoke(identify + ['-format', '%w %h', raw]).split())
    left, top = crop_origin(width, height)
    geometry = f'{CROP_WIDTH}x{CROP_HEIGHT}+{left}+{top}'
    invoke(convert + [raw, '-crop', geometry, '+repage', '-strip', crop])
    lines = parse_tsv(invoke([tesseract, crop, 'stdout', '--psm', '11', 'tsv']))
    rgb = invoke(convert + [crop, '-colorspace', 'sRGB', '-depth', '8', 'RGB:-'], binary=True)
    if len(rgb) != CROP_WIDTH * CROP_HEIGHT * 3:
        raise RuntimeError('unexpected calibrated crop size')
    return {'width': width, 'height': height, 'left': left, 'top': top,
            'image': crop, 'lines': lines, 'rgb': rgb}

def normalize(value):
    return re.sub(r'[^a-z0-9]+', ' ', value.lower()).strip()

def parse_tsv(text):
    grouped = {}
    for row in csv.DictReader(text.splitlines(), delimiter='\t'):
        words = normalize(row.get('text', '')).split()
        if words:
            key = tuple(row[k] for k in ('page_num', 'block_num', 'par_num', 'line_num'))
            grouped.setdefault(key, []).extend((word, row) for word in words)
    return [(normalize(' '.join(word for word, _ in line)), line) for line in grouped.values()]

def boxes(lines, phrase):
    target = normalize(phrase).split()
    found = []
    for _text, line in lines:
        words = [word for word, _ in line]
        for i in range(len(words) - len(target) + 1):
            if words[i:i + len(target)] == target:
                a, b = line[i][1], line[i + len(target) - 1][1]
                x1, y1 = int(a['left']), int(a['top'])
                x2 = int(b['left']) + int(b['width'])
                y2 = max(int(v[1]['top']) + int(v[1]['height']) for v in line[i:i + len(target)])
                found.append((x1, y1, x2, y2))
    return found

def in_region(lines, phrase, region):
    x1, y1, x2, y2 = region
    return any(x1 <= (a+c)//2 <= x2 and y1 <= (b+d)//2 <= y2 for a,b,c,d in boxes(lines, phrase))

def pixel(rgb, x, y):
    index = (y * CROP_WIDTH + x) * 3
    return tuple(rgb[index:index + 3])

def dark(value):
    return len(value) == 3 and max(value) <= 65 and max(value) - min(value) <= 22

def queue_diagnostics(lines, rgb):
    if len(rgb) != CROP_WIDTH * CROP_HEIGHT * 3:
        return {'ready': False, 'reason': 'invalid_crop'}
    anchors = {
        'workspace': in_region(lines, 'Workspace', (70, 90, 210, 145)),
        'project': in_region(lines, 'project', (95, 175, 235, 225)),
        'heading': in_region(lines, 'Work items', (60, 290, 220, 335)),
        'empty': in_region(lines, 'No work items', (60, 480, 300, 580)),
    }
    samples = {f'{x},{y}': pixel(rgb, x, y) for x, y in QUEUE_SAMPLES}
    return {'ready': all(anchors.values()) and all(dark(v) for v in samples.values()),
            'anchors': anchors, 'samples': samples}

def queue_plan(frame):
    diagnostic = queue_diagnostics(frame['lines'], frame['rgb'])
    return QUEUE_CLICK if diagnostic['ready'] else None

def emit_queue(frame, send):
    point = queue_plan(frame)
    if point is None:
        return False
    send(window_point(frame, point))
    return True

def handoff_plan(frame):
    lines, rgb = frame['lines'], frame['rgb']
    if len(rgb) != CROP_WIDTH * CROP_HEIGHT * 3:
        return None
    if not all((in_region(lines, 'Linux native checkpoint', (60, 295, 320, 330)),
                in_region(lines, 'Open delegation', (670, 320, 810, 370)),
                in_region(lines, 'Work item ID', (60, 510, 200, 550)),
                in_region(lines, 'verifier', (300, 540, 410, 575)),
                in_region(lines, 'Result ready', (300, 635, 420, 680)))):
        return None
    candidates = [(a,b,c,d) for a,b,c,d in boxes(lines, 'saved')
                  if 390 <= (a+c)//2 <= 475 and 320 <= (b+d)//2 <= 365]
    if len(candidates) != 1:
        return None
    # The left button is white; the adjacent Copy button is outside this region.
    if not all(min(pixel(rgb, x, y)) >= 250 for x,y in ((357,349),(495,349))):
        return None
    a,b,c,d = candidates[0]
    return ((a+c)//2, (b+d)//2)

def emit_handoff(frame, send):
    point = handoff_plan(frame)
    if point is None:
        return False
    send(window_point(frame, point))
    return True

def return_from_handoff_plan(frame):
    lines, rgb = frame['lines'], frame['rgb']
    if len(rgb) != CROP_WIDTH * CROP_HEIGHT * 3:
        return None
    if not all((in_region(lines, 'Saved handoff', (70, 170, 250, 215)),
                in_region(lines, 'Terminal screen capture', (70, 235, 260, 265)),
                in_region(lines, 'Next action', (70, 265, 200, 290)),
                in_region(lines, 'Linux native checkpoint', (160, 350, 420, 385)),
                in_region(lines, 'saved criteria', (390, 375, 560, 410)))):
        return None
    if not all(min(pixel(rgb, x, y)) >= 250 for x,y in ((626,194),(754,194))):
        return None
    return (690, 194)

def emit_return_from_handoff(frame, send):
    point = return_from_handoff_plan(frame)
    if point is None:
        return False
    send(window_point(frame, point))
    return True

def primary_adjacent(lines, rgb, anchor, side='left'):
    labels = boxes(lines, anchor)
    if len(labels) != 1 or len(rgb) != CROP_WIDTH * CROP_HEIGHT * 3:
        return None
    ax1, ay1, ax2, ay2 = labels[0]
    ys = (ay1 - 5, ay2 + 5)
    if not all(0 <= y < CROP_HEIGHT for y in ys):
        return None
    def runs(y):
        result = []
        start = None
        for x in range(CROP_WIDTH + 1):
            on = x < CROP_WIDTH and dark(pixel(rgb, x, y))
            if on and start is None:
                start = x
            if not on and start is not None:
                if 60 <= x - start <= 270:
                    result.append((start, x - 1))
                start = None
        return result
    candidates = []
    for a in runs(ys[0]):
        for b in runs(ys[1]):
            if abs(a[0]-b[0]) > 3 or abs(a[1]-b[1]) > 3:
                continue
            lo, hi = max(a[0], b[0]), min(a[1], b[1])
            gap = ax1 - hi if side == 'left' else lo - ax2
            if not 4 <= gap <= 70:
                continue
            cy = (ay1 + ay2) // 2
            if dark(pixel(rgb, lo + 2, cy)) and dark(pixel(rgb, hi - 2, cy)):
                candidates.append(((lo + hi) // 2, cy))
    return candidates[0] if len(candidates) == 1 else None

def role_selection_transition(before, after):
    if (before['width'], before['height'], before['left'], before['top']) != (after['width'], after['height'], after['left'], after['top']):
        return {'verified': False, 'reason': 'frame_geometry_changed'}
    first = boxes(before['lines'], 'Linux fixture')
    # The selected button's highlighted text may not be recognized by OCR.
    # Anchor its pixels to the uniquely identified role in the preceding frame.
    if len(first) != 1:
        return {'verified': False, 'reason': 'role_anchor_missing'}
    first_refresh = boxes(before['lines'], 'Refresh roles')
    next_refresh = boxes(after['lines'], 'Refresh roles')
    if (len(first_refresh) != 1 or len(next_refresh) != 1 or
            any(abs(a-b) > 3 for a, b in zip(first_refresh[0], next_refresh[0]))):
        return {'verified': False, 'reason': 'form_anchor_changed'}
    x1, y1, x2, y2 = first[0]
    left, right = max(0, x1-12), min(CROP_WIDTH, x2+90)
    top, bottom = max(0, y1-10), min(CROP_HEIGHT, y2+12)
    changed = 0
    for y in range(top, bottom):
        for x in range(left, right):
            if max(abs(a-b) for a, b in zip(pixel(before['rgb'], x, y), pixel(after['rgb'], x, y))) >= 16:
                changed += 1
    previous = primary_adjacent(before['lines'], before['rgb'], 'Refresh roles')
    current = primary_adjacent(after['lines'], after['rgb'], 'Refresh roles')
    return {'verified': changed >= 40 and previous is None and current is not None,
            'roleChangedPixels': changed, 'savePreviouslyEnabled': previous is not None,
            'saveNowEnabled': current is not None}
