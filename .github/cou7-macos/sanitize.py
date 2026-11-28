import os
import re
import sys

try:
    with open(sys.argv[2], encoding='utf-8', errors='replace') as source:
        for raw in source.read(12000).splitlines()[:8]:
            line = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', raw)
            for value in (os.environ.get('USER'), os.environ.get('HOME'), os.environ.get('RUNNER_TEMP')):
                if value:
                    line = line.replace(value, '<redacted>')
            line = re.sub(r'(?<![A-Za-z0-9])/(?:[^\s:]+/)*[^\s:]+', '<path>', line)
            line = re.sub(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', '<ip>', line)
            line = re.sub(r'[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+', '<email>', line)
            print(sys.argv[1] + '=' + line[:280])
except OSError:
    print(sys.argv[1] + '=unavailable')
