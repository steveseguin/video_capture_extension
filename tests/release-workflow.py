"""Execute the release workflow's version step with normal and shell-like input."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import yaml

root = Path(__file__).resolve().parent.parent
workflow_path = Path(os.environ.get('RELEASE_WORKFLOW_PATH', root / '.github/workflows/release.yml'))
workflow = yaml.safe_load(workflow_path.read_text(encoding='utf-8'))
step = next(step for step in workflow['jobs']['build-and-release']['steps'] if step.get('id') == 'get_version')
bash = 'C:/Program Files/Git/bin/bash.exe' if os.name == 'nt' else shutil.which('bash')
assert bash, 'Bash is required'
for item in workflow['jobs']['build-and-release']['steps']:
    if item.get('name') in ('Get version', 'Update manifest version'):
        subprocess.run([bash, '-n'], input=item['run'], text=True, check=True)

for event, version, ref, expected in [
    ('workflow_dispatch', '1.2.3', '', '1.2.3'),
    ('push', '', 'refs/tags/v2.3.4', '2.3.4'),
    ('workflow_dispatch', '1.2.3$(touch injection-marker)', '', '1.2.3$(touch injection-marker)'),
]:
    with tempfile.TemporaryDirectory(prefix='vdo-release-test-') as directory:
        output = Path(directory) / 'step-output'
        script = step['run']
        # Match GitHub's expression substitution, so the test also reproduces
        # shell expansion in the original workflow before the fix.
        script = script.replace('${{ github.event_name }}', event).replace('${{ github.event.inputs.version }}', version)
        subprocess.run([bash, '-e', '-c', script], cwd=directory, check=True,
                       env={**os.environ, 'RELEASE_EVENT': event, 'VERSION_INPUT': version,
                            'GITHUB_REF': ref, 'GITHUB_OUTPUT': output.as_posix()})
        assert not (Path(directory) / 'injection-marker').exists(), 'Version input executed a shell command'
        assert output.read_text().splitlines() == [f'VERSION=v{expected}', f'VERSION_NUMBER={expected}']
print('PASS: manual/tag versions and shell-like input are handled as data')
