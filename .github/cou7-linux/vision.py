import csv
import re

CROP_WIDTH, CROP_HEIGHT = 1000, 800
QUEUE_SAMPLES = ((815, 311), (929, 311), (873, 319))
QUEUE_CLICK = (873, 319)

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

def boxes(lines, phrase, left=0, top=0):
    target = normalize(phrase).split()
    found = []
    for _text, line in lines:
        words = [word for word, _ in line]
        for i in range(len(words) - len(target) + 1):
            if words[i:i + len(target)] == target:
                a, b = line[i][1], line[i + len(target) - 1][1]
                x1, y1 = int(a['left']) - left, int(a['top']) - top
                x2 = int(b['left']) + int(b['width']) - left
                y2 = max(int(v[1]['top']) + int(v[1]['height']) for v in line[i:i + len(target)]) - top
                found.append((x1, y1, x2, y2))
    return found

def in_region(lines, phrase, region, left=0, top=0):
    x1, y1, x2, y2 = region
    return any(x1 <= (a+c)//2 <= x2 and y1 <= (b+d)//2 <= y2 for a,b,c,d in boxes(lines, phrase, left, top))

def pixel(rgb, x, y):
    index = (y * CROP_WIDTH + x) * 3
    return tuple(rgb[index:index + 3])

def dark(value):
    return len(value) == 3 and max(value) <= 65 and max(value) - min(value) <= 22

def queue_diagnostics(lines, rgb, left=0, top=0):
    if len(rgb) != CROP_WIDTH * CROP_HEIGHT * 3:
        return {'ready': False, 'reason': 'invalid_crop'}
    anchors = {
        'workspace': in_region(lines, 'Workspace', (70, 90, 210, 145), left, top),
        'project': in_region(lines, 'project', (95, 175, 235, 225), left, top),
        'heading': in_region(lines, 'Work items', (60, 290, 220, 335), left, top),
        'role': in_region(lines, 'Linux fixture verifier', (105, 340, 325, 420), left, top),
        'empty': in_region(lines, 'No work items', (60, 480, 300, 580), left, top),
    }
    samples = {f'{x},{y}': pixel(rgb, x, y) for x, y in QUEUE_SAMPLES}
    return {'ready': all(anchors.values()) and all(dark(v) for v in samples.values()),
            'anchors': anchors, 'samples': samples}

def primary_adjacent(lines, rgb, anchor, side='left', left=0, top=0):
    labels = boxes(lines, anchor, left, top)
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
