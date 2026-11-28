import subprocess
import sys

seconds, output, error, *command = sys.argv[1:]
try:
    with open(output, 'wb') as out, open(error, 'wb') as err:
        result = subprocess.run(command, stdout=out, stderr=err, timeout=int(seconds), check=False)
    sys.exit(result.returncode if result.returncode >= 0 else 128 - result.returncode)
except subprocess.TimeoutExpired:
    sys.exit(124)
except OSError:
    sys.exit(125)
