import csv
import os
import subprocess
import sys

evidence = os.environ['COU7_EVIDENCE']
app = os.environ['COU7_APP']
project = os.environ['COU7_PROJECT']
stage = 'initial'

def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True)

def shot(name):
    path = os.path.join(evidence, name + '.png')
    run(app, 'shot', path)
    return path

def click(words, offset=0):
    path = shot('ui-' + stage)
    rows = list(csv.DictReader(run('tesseract', path, 'stdout', 'tsv').stdout.splitlines(), delimiter='\t'))
    grouped = {}
    for row in rows:
        text = row.get('text', '').strip()
        if text:
            key = tuple(row[k] for k in ('page_num', 'block_num', 'par_num', 'line_num'))
            grouped.setdefault(key, []).append(row)
    target = words.lower().split()
    for line in grouped.values():
        text = [r['text'].strip().lower() for r in line]
        for i in range(len(text) - len(target) + 1):
            if text[i:i + len(target)] == target:
                first, last = line[i], line[i + len(target) - 1]
                x = (int(first['left']) + int(last['left']) + int(last['width'])) // 2
                y = int(first['top']) + int(first['height']) // 2 + offset
                run('xdotool', 'mousemove', str(x), str(y), 'click', '1')
                return
    raise RuntimeError('visible control not located: ' + words)

def type_text(text):
    run('xdotool', 'type', '--clearmodifiers', '--', text)

try:
    if len(sys.argv) > 1 and sys.argv[1] == 'reopen':
        stage = 'reopen-workspace'; click('Workspace')
        stage = 'reopen-list'; click('Work items')
        stage = 'reopen-item'; click('Open work item')
        stage = 'reopen-handoff'; click('Read saved handoff')
        stage = 'reopened-handoff'
        image = shot(stage)
        text = run('tesseract', image, 'stdout').stdout.lower()
        if 'linux native checkpoint' not in text or 'next action' not in text:
            raise RuntimeError('saved heading or next action not visible in native screenshot')
        stage = 'return-to-item'; click('Back to work item')
        stage = 'open-delegation'; click('Open delegation')
        stage = 'reopened-delegation'; shot(stage)
        print('UI_REOPENED_HANDOFF_AND_DELEGATION')
        sys.exit(0)
    stage = 'workspace'; click('Workspace')
    stage = 'work-items'; click('Work items')
    stage = 'new-item'; click('New work item')
    stage = 'title'; click('Title', 28); type_text('Linux native checkpoint')
    stage = 'criteria'; click('Acceptance criteria', 58)
    type_text('Name the first heading.'); run('xdotool', 'key', 'Return'); type_text('Give a concrete next action.')
    stage = 'role'; click('Linux fixture')
    stage = 'save'; click('Save work item')
    stage = 'delegate'; click('Delegate')
    stage = 'actor'; click('Actor name', 28); type_text('Operator')
    stage = 'confirm'; click('Confirm delegation')
    stage = 'delegated'; shot(stage)
    print('UI_CREATED_AND_DELEGATED')
except Exception as error:
    try: shot('ui-failed-' + stage)
    except Exception: pass
    print('UI_FIRST_FAILURE=' + stage + ': ' + str(error), file=sys.stderr)
    sys.exit(1)
