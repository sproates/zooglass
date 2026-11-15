"""Explicit isolated production-runtime and host builds for the fleet strategy control."""
import importlib.util
import io
import json
import pathlib
import shutil
import subprocess
import sys
import tarfile

sys.dont_write_bytecode = True

HELPER = pathlib.Path(__file__).with_name('prepare-generation-clock-mutation.py')
spec = importlib.util.spec_from_file_location('control_preparation', HELPER)
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
SOURCE = 'src/main/java/io/zooglass/strategy/update/LatestBySequence.java'
CLASS = 'io/zooglass/strategy/update/LatestBySequence.class'
BEFORE = '''        JsonNode nextSequence = SequenceValues.read(incoming, sequenceField);
        if (nextSequence == null) {
            return FieldUpdate.unchanged();
        }

        JsonNode currentSequence = SequenceValues.read(current, sequenceField);
        if (currentSequence != null && SequenceValues.compare(nextSequence, currentSequence) <= 0) {
            return FieldUpdate.unchanged();
        }

'''.encode()


def differences(normal, mutant, allowed, required):
    if normal.keys() != mutant.keys():
        raise ValueError('Artifact layouts differ')
    changed = sorted(key for key in normal if normal[key] != mutant[key])
    if set(changed) - allowed != required:
        raise ValueError(f'Unexpected artifact content changes: {changed}')
    return changed


def prepare(root):
    checkout = pathlib.Path(__file__).resolve().parents[2]
    if subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no', '--', 'zooglass'], cwd=checkout).strip():
        raise ValueError('Preparation requires clean committed production/host sources')
    if subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', '--', 'zooglass'], cwd=checkout).strip():
        raise ValueError('Preparation has untracked relevant sources')
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=checkout, text=True).strip()
    archive_bytes = subprocess.check_output(['git', 'archive', '--format=tar', revision, 'zooglass'], cwd=checkout)
    root.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive_bytes)) as archive:
        archive.extractall(root, filter='data')
    source = root / 'zooglass'
    rule = source / SOURCE
    original = rule.read_bytes()
    if original.count(BEFORE) != 1:
        raise ValueError('LatestBySequence mutation site changed')
    mutant = original.replace(BEFORE, b'')
    (root / 'strategy-original.java').write_bytes(original)
    (root / 'strategy-mutant.java').write_bytes(mutant)
    repository = root / 'maven-repository'
    commands = []
    for name, payload in [('normal', original), ('mutant', mutant)]:
        rule.write_bytes(payload)
        commands.append(common.maven(['-DskipTests', 'clean', 'install'], source, repository))
        commands.append(common.maven(['-f', 'simulation-host/pom.xml', '-DskipTests', 'clean', 'package'], source, repository))
        shutil.copyfile(source / 'target/zooglass-runtime.jar', root / f'{name}-runtime.jar')
        shutil.copyfile(source / 'simulation-host/target/zooglass-simulation.jar', root / f'{name}.jar')
    hosts = {name: common.jar_inventory(root / f'{name}.jar') for name in ['normal', 'mutant']}
    runtimes = {name: common.jar_inventory(root / f'{name}-runtime.jar') for name in hosts}
    entries = [name for name in hosts['normal'] if name.startswith('BOOT-INF/lib/zooglass-') and name.endswith('-runtime.jar')]
    if len(entries) != 1:
        raise ValueError('Expected one embedded production runtime')
    entry = entries[0]
    for name in hosts:
        if hosts[name][entry] != common.file_digest(root / f'{name}-runtime.jar'):
            raise ValueError('Host did not embed newly built runtime')
    changed = differences(hosts['normal'], hosts['mutant'], {'META-INF/maven/io.zooglass/zooglass-simulation/pom.properties'}, {entry})
    nested = differences(runtimes['normal'], runtimes['mutant'], {'META-INF/maven/io.zooglass/zooglass/pom.properties'}, {CLASS})
    manifest = {
        'format': 'timeline-fleet-strategy-preparation/v1', 'revision': revision,
        'sourceArchiveSha256': common.digest(archive_bytes),
        'recipeSha256': common.file_digest(pathlib.Path(__file__)),
        'helperSha256': common.file_digest(HELPER), 'commands': commands,
        'java': subprocess.check_output(['java', '-version'], stderr=subprocess.STDOUT, text=True).strip(),
        'mutation': {'file': SOURCE, 'before': BEFORE.decode(), 'after': '',
                     'originalSha256': common.digest(original), 'mutatedSha256': common.digest(mutant),
                     'class': CLASS, 'originalClassSha256': runtimes['normal'][CLASS], 'mutatedClassSha256': runtimes['mutant'][CLASS]},
        'runtime': {'entry': entry, **{name: common.file_digest(root / f'{name}-runtime.jar') for name in hosts}},
        'artifacts': {name: common.file_digest(root / f'{name}.jar') for name in hosts},
        'changedEntries': changed, 'changedRuntimeEntries': nested,
    }
    (root / 'preparation.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Prepared fleet control at {root}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: prepare-fleet-strategy-mutation.py NEW_DIRECTORY')
    prepare(pathlib.Path(sys.argv[1]).resolve())
