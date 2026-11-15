"""Explicit isolated preparation of real priority and restart-clock negative controls."""
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
MUTATIONS = {
    'priority': {
        'file': 'src/main/java/io/zooglass/strategy/contribution/SourcePriority.java',
        'class': 'io/zooglass/strategy/contribution/SourcePriority.class',
        'before': 'for (String source : sources) {',
        'after': 'for (String source : sources.reversed()) {',
    },
    'clock': {
        'file': common.SOURCE_FILE,
        'class': common.CLASS_FILE,
        'before': common.BEFORE.decode(),
        'after': common.GENERATION_ORIGIN.decode(),
    },
}


def changed(normal, mutant, allowed, required):
    if normal.keys() != mutant.keys():
        raise ValueError('Artifact layouts differ')
    delta = sorted(key for key in normal if normal[key] != mutant[key])
    if set(delta) - allowed != required:
        raise ValueError(f'Unexpected artifact changes: {delta}')
    return delta


def prepare(root):
    checkout = pathlib.Path(__file__).resolve().parents[2]
    for args in [
        ['status', '--porcelain', '--', 'zooglass'],
        ['ls-files', '--others', '--exclude-standard', '--', 'zooglass'],
    ]:
        if subprocess.check_output(['git', *args], cwd=checkout).strip():
            raise ValueError('Preparation requires clean committed Java sources')
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=checkout, text=True).strip()
    archive_bytes = subprocess.check_output(['git', 'archive', '--format=tar', revision, 'zooglass'], cwd=checkout)
    root.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive_bytes)) as archive:
        archive.extractall(root, filter='data')
    source = root / 'zooglass'
    repository = root / 'maven-repository'
    commands = [common.maven(['-DskipTests', 'clean', 'install'], source, repository)]
    package = ['-f', 'simulation-host/pom.xml', '-DskipTests', 'clean', 'package']
    commands.append(common.maven(package, source, repository))
    host_path = source / 'simulation-host/target/zooglass-simulation.jar'
    runtime_path = source / 'target/zooglass-runtime.jar'
    shutil.copyfile(host_path, root / 'normal.jar')
    shutil.copyfile(runtime_path, root / 'normal-runtime.jar')
    normal = common.jar_inventory(root / 'normal.jar')
    normal_runtime = common.jar_inventory(root / 'normal-runtime.jar')
    entries = [key for key in normal if key.startswith('BOOT-INF/lib/zooglass-') and key.endswith('-runtime.jar')]
    if len(entries) != 1 or normal[entries[0]] != common.file_digest(root / 'normal-runtime.jar'):
        raise ValueError('Expected newly built embedded production runtime')
    entry = entries[0]
    mutations = {}
    # Clock first: reuse the normal runtime; priority then builds its changed runtime.
    for name in ['clock', 'priority']:
        definition = MUTATIONS[name]
        rule = source / definition['file']
        original = rule.read_text()
        if original.count(definition['before']) != 1:
            raise ValueError(f'{name} mutation site changed')
        mutant = original.replace(definition['before'], definition['after'])
        (root / f'{name}-original.java').write_text(original)
        (root / f'{name}-mutant.java').write_text(mutant)
        rule.write_text(mutant)
        if name == 'priority':
            commands.append(common.maven(['-DskipTests', 'clean', 'install'], source, repository))
        commands.append(common.maven(package, source, repository))
        shutil.copyfile(host_path, root / f'{name}.jar')
        host = common.jar_inventory(root / f'{name}.jar')
        runtime = common.jar_inventory(runtime_path)
        if host[entry] != common.file_digest(runtime_path):
            raise ValueError('Host embeds stale runtime')
        host_delta = changed(normal, host,
            {'META-INF/maven/io.zooglass/zooglass-simulation/pom.properties'},
            {definition['class']} if name == 'clock' else {entry})
        runtime_delta = changed(normal_runtime, runtime,
            {'META-INF/maven/io.zooglass/zooglass/pom.properties'},
            set() if name == 'clock' else {definition['class']})
        mutations[name] = {**definition,
            'originalSha256': common.digest(original.encode()),
            'mutatedSha256': common.digest(mutant.encode()),
            'changedEntries': host_delta, 'changedRuntimeEntries': runtime_delta,
            'artifactSha256': common.file_digest(root / f'{name}.jar'),
            'runtimeSha256': host[entry]}
        rule.write_text(original)
    manifest = {'format': 'timeline-order-controls-preparation/v1', 'revision': revision,
        'sourceArchiveSha256': common.digest(archive_bytes),
        'recipeSha256': common.file_digest(pathlib.Path(__file__)),
        'helperSha256': common.file_digest(HELPER), 'commands': commands,
        'java': subprocess.check_output(['java', '-version'], stderr=subprocess.STDOUT, text=True).strip(),
        'normalSha256': common.file_digest(root / 'normal.jar'),
        'runtime': {'entry': entry, 'sha256': normal[entry]}, 'mutations': mutations}
    (root / 'preparation.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Prepared Order controls at {root}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: prepare-order-controls.py NEW_DIRECTORY')
    prepare(pathlib.Path(sys.argv[1]).resolve())
