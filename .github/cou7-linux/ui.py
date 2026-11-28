import csv
import json
import os
import re
import subprocess
import sys
import time

evidence = os.environ['COU7_EVIDENCE']
raw_shots = os.environ['COU7_RAW_SHOTS']
scratch = os.environ['COU7_SCRATCH']
app = os.environ['COU7_APP']
project = os.environ['COU7_PROJECT']
window = os.environ['COU7_WINDOW_ID']
app_pid = int(os.environ['COU7_APP_PID'])
node = os.environ['COU7_NODE']
cli = os.environ['COU7_CLI']
title = 'Linux native checkpoint'
criteria = ['Name the first heading.', 'Give a concrete next action.']
stage = 'initial'
last_success = 'none'

def run(*args, timeout=12, cwd=None):
    return subprocess.run(args, check=True, text=True, capture_output=True, timeout=timeout, cwd=cwd)

def mark(name):
    global last_success
    last_success = name
    print('UI_REACHED=' + name, flush=True)

def normalize(value):
    return re.sub(r'[^a-z0-9]+', ' ', value.lower()).strip()

def capture(deadline):
    path = os.path.join(raw_shots, 'ui-current.png')
    left = deadline - time.monotonic()
    if left <= 0:
        raise TimeoutError('screenshot deadline')
    run(app, 'shot', path, timeout=min(10, left))
    left = deadline - time.monotonic()
    if left <= 0:
        raise TimeoutError('OCR deadline')
    rows = list(csv.DictReader(run('tesseract', path, 'stdout', '--psm', '11', 'tsv', timeout=min(10, left)).stdout.splitlines(), delimiter='\t'))
    grouped = {}
    for row in rows:
        word = normalize(row.get('text', ''))
        if word:
            key = tuple(row[k] for k in ('page_num', 'block_num', 'par_num', 'line_num'))
            grouped.setdefault(key, []).append((word, row))
    lines = [(normalize(' '.join(word for word, _ in line)), line) for line in grouped.values()]
    return path, lines

def text_has(lines, phrase):
    phrase = normalize(phrase)
    return any(phrase in text for text, _ in lines)

def export_image(raw, name):
    path = os.path.join(evidence, 'ui-' + name + '.png')
    run('convert', raw, '-gravity', 'center', '-crop', '1000x800+0+0', '+repage', '-strip', path)

def ready(name, required, alternatives=(), absent=(), seconds=35):
    global stage
    stage = name
    end = time.monotonic() + seconds
    last = None
    while time.monotonic() < end:
        try:
            last = capture(end)
            lines = last[1]
            if (all(text_has(lines, x) for x in required)
                and (not alternatives or any(text_has(lines, x) for x in alternatives))
                and not any(text_has(lines, x) for x in absent)):
                export_image(last[0], name)
                mark(name)
                return last
        except (subprocess.SubprocessError, OSError, TimeoutError):
            pass
    if last:
        export_image(last[0], 'failed-' + name)
    raise RuntimeError('postcondition absent: ' + ', '.join(required) +
                       ('; alternatives: ' + ', '.join(alternatives) if alternatives else ''))

def locate(snapshot, phrase, topmost=False):
    target = normalize(phrase).split()
    matches = []
    for _text, line in snapshot[1]:
        words = [word for word, _ in line]
        for i in range(len(words) - len(target) + 1):
            if words[i:i + len(target)] == target:
                first, last = line[i][1], line[i + len(target) - 1][1]
                x = (int(first['left']) + int(last['left']) + int(last['width'])) // 2
                y = int(first['top']) + int(first['height']) // 2
                matches.append((x, y))
    if topmost and len(matches) > 1:
        matches.sort(key=lambda point: point[1])
        if matches[0][1] < matches[1][1] - 5:
            return matches[0]
    if len(matches) != 1:
        raise RuntimeError(f'control {phrase!r}: expected one match, observed {len(matches)}')
    return matches[0]

def click(snapshot, phrase, offset=0, topmost=False):
    owner = int(run('xdotool', 'getwindowpid', window).stdout.strip())
    if owner != app_pid:
        raise RuntimeError('window does not belong to the launched Desktop process')
    geometry = dict(line.split('=', 1) for line in run('xdotool', 'getwindowgeometry', '--shell', window).stdout.splitlines() if '=' in line)
    width, height = map(int, run('identify', '-format', '%w %h', snapshot[0]).stdout.split())
    if (width, height) != (int(geometry['WIDTH']), int(geometry['HEIGHT'])):
        raise RuntimeError('screenshot dimensions differ from the target window')
    x, y = locate(snapshot, phrase, topmost)
    y += offset
    if not (0 <= x < width and 0 <= y < height):
        raise RuntimeError('control coordinates are outside the target window')
    run('xdotool', 'windowfocus', '--sync', window)
    if int(run('xdotool', 'getwindowfocus').stdout.strip()) != int(window):
        raise RuntimeError('target window did not acquire keyboard focus')
    run('xdotool', 'mousemove', '--window', window, '--sync', str(x), str(y), 'click', '1')

def type_text(text):
    run('xdotool', 'type', '--clearmodifiers', '--', text)

def cli_read(*args):
    result = run(node, cli, 'work-item', *args, cwd=project, timeout=20)
    value = json.loads(result.stdout)
    if value.get('success') is not True:
        raise RuntimeError('installed CLI readback was unsuccessful')
    return value

def read_created_item():
    listing = cli_read('list')
    items = listing.get('items', [])
    if len(items) != 1 or items[0].get('title') != title:
        raise RuntimeError('the project does not contain exactly the expected item')
    item = cli_read('show', '--id', items[0]['id'])['item']
    if item.get('title') != title or item.get('roleId') != 'verifier' or item.get('criteria') != criteria:
        raise RuntimeError('saved item readback does not match the UI inputs')
    if not isinstance(item.get('lifecycle', {}).get('revision'), int):
        raise RuntimeError('saved item revision is absent')
    record = {'id': item['id'], 'title': title, 'roleId': item['roleId'], 'criteria': item['criteria'],
              'revision': item['lifecycle']['revision']}
    with open(os.path.join(scratch, 'ui-created.json'), 'w', encoding='utf-8') as handle:
        json.dump(record, handle)
    print('UI_ITEM_READBACK=' + json.dumps(record), flush=True)
    return item

def mark_mutation(name):
    with open(os.path.join(scratch, 'ui-' + name + '-attempted'), 'w', encoding='ascii') as handle:
        handle.write('one attempt\n')
    print('UI_MUTATION_ATTEMPTED=' + name, flush=True)

def initial_workspace():
    return ready('workspace-ready', ['Work items', 'project'], absent=['Loading Workspace'])

def observe_overlay(name, expected):
    global stage
    stage = 'overlay-' + name
    end = time.monotonic() + 35
    last = None
    while time.monotonic() < end:
        try:
            left = end - time.monotonic()
            status = json.loads(run(app, 'status', timeout=min(8, left)).stdout)
            present = 'council' in (status.get('overlays') or [])
            last = capture(end)
            content = (name != 'reopened' or
                       (text_has(last[1], 'Work items') and text_has(last[1], 'project')
                        and not text_has(last[1], 'Loading Workspace')))
            if present == (expected == 'present') and content:
                export_image(last[0], stage)
                print('UI_OVERLAY=' + json.dumps({'stage': name, 'councilOverlay': present}), flush=True)
                mark(stage)
                return
        except (subprocess.SubprocessError, OSError, TimeoutError, ValueError):
            pass
    if last:
        export_image(last[0], 'failed-' + stage)
    raise RuntimeError('expected overlay state or reopened Workspace content not observed')

try:
    if len(sys.argv) > 1 and sys.argv[1] == 'overlay':
        observe_overlay(sys.argv[2], sys.argv[3])
        sys.exit(0)
    if len(sys.argv) > 1 and sys.argv[1] == 'reopen':
        item = json.load(open(os.path.join(scratch, 'ui-created.json'), encoding='utf-8'))
        final = cli_read('show', '--id', item['id'])['item']
        session = final.get('job', {}).get('sessionId')
        if final.get('state') != 'result_ready' or not session:
            raise RuntimeError('saved item is not ready with a linked job')
        snap = initial_workspace()
        click(snap, 'Work items')
        snap = ready('reopened-list-or-detail', [title], alternatives=['Open work item', 'Read saved handoff'])
        if text_has(snap[1], 'Open work item'):
            click(snap, 'Open work item')
            snap = ready('reopened-specific-item', [title, 'Read saved handoff', 'Open delegation'])
        else:
            snap = ready('reopened-specific-item', [title, 'Read saved handoff', 'Open delegation'])
        click(snap, 'Read saved handoff')
        snap = ready('reopened-handoff', ['Saved handoff', 'Linux Native Checkpoint', 'Next action'],
                     alternatives=['compare the heading', 'saved criteria'])
        click(snap, 'Back to work item')
        snap = ready('returned-to-item', [title, 'Open delegation'])
        click(snap, 'Open delegation')
        snap = ready('reopened-delegation', ['Copy session ID'], alternatives=[session, session[:15]])
        print('UI_REOPENED_HANDOFF_AND_DELEGATION=' + session, flush=True)
        sys.exit(0)

    snap = initial_workspace()
    click(snap, 'Work items')
    snap = ready('queue-ready', ['Work items', 'New work item'])
    click(snap, 'New work item')
    snap = ready('form-and-roles-ready', ['Title', 'Acceptance criteria', 'Linux fixture', 'Save work item'],
                 absent=['Loading roles'])
    click(snap, 'Title', 25)
    type_text(title)
    snap = ready('title-entered', [title, 'Acceptance criteria', 'Linux fixture'])
    click(snap, 'Acceptance criteria', 58)
    type_text(criteria[0]); run('xdotool', 'key', 'Return'); type_text(criteria[1])
    snap = ready('criteria-entered', [title, 'Name the first heading', 'Give a concrete next action', 'Linux fixture'])
    click(snap, 'Linux fixture')
    snap = ready('role-chosen', [title, 'Save work item', 'Linux fixture'])
    mark_mutation('save')
    click(snap, 'Save work item')
    snap = ready('created-detail', [title, 'Delegate'], absent=['Saving work item'])
    item = read_created_item()
    mark('created-readback')
    click(snap, 'Delegate', topmost=True)
    snap = ready('delegation-form', ['Confirm delegation', 'Actor name', 'Responsible role'])
    click(snap, 'Actor name', 25)
    type_text('Operator')
    snap = ready('actor-entered', ['Operator', 'Confirm delegation'])
    mark_mutation('delegate')
    click(snap, 'Confirm delegation')
    ready('delegation-confirmed', [title], alternatives=['Saved request', 'Linked delegation', 'In progress'],
          absent=['Confirm delegation'])
    current = cli_read('show', '--id', item['id'])['item']
    if not current.get('job', {}).get('sessionId'):
        raise RuntimeError('submitted delegation has no readable job yet')
    print('UI_DELEGATION_READBACK=' + json.dumps({'itemId': item['id'], 'sessionId': current['job']['sessionId'],
                                                  'linked': current['job'].get('linked'), 'state': current.get('state')}), flush=True)
    mark('delegation-readback')
    print('UI_CREATED_AND_DELEGATED', flush=True)
except Exception as error:
    print('UI_LAST_SUCCESS=' + last_success, flush=True)
    print('UI_FIRST_FAILURE=' + stage + ': ' + str(error), file=sys.stderr, flush=True)
    sys.exit(1)
