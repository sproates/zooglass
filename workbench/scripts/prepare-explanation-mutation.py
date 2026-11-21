"""Explicit isolated builds: change one reported reason, never the update decision."""
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
BEFORE = b'FieldUpdate.Reason.LATEST_OLDER'
AFTER = b'FieldUpdate.Reason.LATEST_EQUAL'


def mutate(original):
    if original.count(BEFORE) != 1:
        raise ValueError('LatestBySequence reason mutation site changed')
    return original.replace(BEFORE, AFTER)


def differences(normal, mutant, metadata, required):
    if normal.keys() != mutant.keys():
        raise ValueError('Artifact layouts differ')
    changed = sorted(key for key in normal if normal[key] != mutant[key])
    if set(changed) - {metadata} != {required}:
        raise ValueError(f'Unexpected artifact content changes: {changed}')
    return changed


def prepare(root):
    checkout = pathlib.Path(__file__).resolve().parents[2]

    def git(*arguments):
        return subprocess.check_output(['git', *arguments], cwd=checkout, timeout=15)

    if git('status', '--porcelain', '--untracked-files=no', '--', 'zooglass').strip():
        raise ValueError('Preparation requires clean committed production/host sources')
    if git('ls-files', '--others', '--exclude-standard', '--', 'zooglass').strip():
        raise ValueError('Preparation has untracked production/host sources')
    revision = git('rev-parse', 'HEAD').decode().strip()
    archive_bytes = git('archive', '--format=tar', revision, 'zooglass')
    root.mkdir()  # Never reuse a preparation directory or touch the live checkout.
    with tarfile.open(fileobj=io.BytesIO(archive_bytes)) as archive:
        archive.extractall(root, filter='data')
    source = root / 'zooglass'
    rule = source / SOURCE
    original = rule.read_bytes()
    mutant = mutate(original)
    (root / 'reason-original.java').write_bytes(original)
    (root / 'reason-mutant.java').write_bytes(mutant)
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
    changed = differences(hosts['normal'], hosts['mutant'],
                          'META-INF/maven/io.zooglass/zooglass-simulation/pom.properties', entry)
    nested = differences(runtimes['normal'], runtimes['mutant'],
                         'META-INF/maven/io.zooglass/zooglass/pom.properties', CLASS)
    manifest = {
        'format': 'timeline-explanation-preparation/v1', 'revision': revision,
        'javaSourceTree': git('rev-parse', f'{revision}:zooglass').decode().strip(),
        'sourceArchiveSha256': common.digest(archive_bytes),
        'recipeSha256': common.file_digest(pathlib.Path(__file__)),
        'helperSha256': common.file_digest(HELPER), 'commands': commands,
        'java': subprocess.check_output(['java', '-version'], stderr=subprocess.STDOUT,
                                        text=True, timeout=10).strip(),
        'mutation': {'file': SOURCE, 'before': BEFORE.decode(), 'after': AFTER.decode(),
                     'originalSha256': common.digest(original), 'mutatedSha256': common.digest(mutant),
                     'class': CLASS, 'originalClassSha256': runtimes['normal'][CLASS],
                     'mutatedClassSha256': runtimes['mutant'][CLASS]},
        'runtime': {'entry': entry, **{name: common.file_digest(root / f'{name}-runtime.jar') for name in hosts}},
        'artifacts': {name: common.file_digest(root / f'{name}.jar') for name in hosts},
        'changedEntries': changed, 'changedRuntimeEntries': nested,
    }
    (root / 'preparation.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Prepared explanation control at {root}')


if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1].startswith('--'):
        raise SystemExit('Usage: prepare-explanation-mutation.py NEW_DIRECTORY')
    prepare(pathlib.Path(sys.argv[1]).resolve())
