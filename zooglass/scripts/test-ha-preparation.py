#!/usr/bin/env python3
"""Check HA preparation rejects stale source/class pairs; no Java or Docker is invoked."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch
import zipfile
sys.dont_write_bytecode = True
scripts = Path(__file__).resolve().parent
def load(name):
    spec = importlib.util.spec_from_file_location(name, scripts / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result
with tempfile.TemporaryDirectory() as location:
    m = load('prepare-ha-controls')
    root = Path(location)
    m.SERVICE = root
    m.TARGET = root / 'target'
    m.TARGET.mkdir()
    m.OUTPUT = m.TARGET / 'ha-fence-controls'
    m.SOURCE = root / 'src/main/java' / m.PACKAGE / 'PostgresAuthority.java'
    m.SOURCE.parent.mkdir(parents=True)
    m.SOURCE.write_text(m.ORIGINAL)
    m.RUNTIME = m.TARGET / 'runtime.jar'
    m.SERVICE_JAR = m.TARGET / 'service.jar'
    for jar_path, prefix in ((m.RUNTIME, ''), (m.SERVICE_JAR, 'BOOT-INF/classes/')):
        with zipfile.ZipFile(jar_path, 'w') as jar:
            jar.writestr(prefix + m.AUTHORITY.as_posix(), b'authority')
    for name in m.ORACLE_SOURCES:
        source = root / 'src/test/java' / m.PACKAGE / (name + '.java')
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text('source-' + name)
        cls = m.TARGET / 'test-classes' / m.PACKAGE / (name + '.class')
        cls.parent.mkdir(parents=True, exist_ok=True)
        cls.write_bytes(('class-' + name).encode())
    _, manifest = m.inputs()
    controls = {}
    for name, replacement in m.VARIANTS.items():
        cls = m.OUTPUT / name / m.AUTHORITY
        cls.parent.mkdir(parents=True)
        cls.write_bytes(name.encode())
        controls[name] = {'sourceSha256': m.digest(replacement.encode()), 'classSha256': m.file_hash(cls)}
    manifest['controls'] = controls
    (m.OUTPUT / 'manifest.json').write_text(json.dumps(manifest))
    m.verify()
    for name in ('PostgresTestDatabase', 'HaStaticProfileTests'):
        for base, suffix in ((root / 'src/test/java', '.java'), (m.TARGET / 'test-classes', '.class')):
            path = base / m.PACKAGE / (name + suffix)
            before = path.read_bytes()
            path.write_bytes(before + b'changed')
            try:
                m.verify()
                raise AssertionError('stale helper was accepted')
            except ValueError as error:
                assert 'Stale control preparation' in str(error)
            finally:
                path.write_bytes(before)
    calls = []
    def fake_javac(args, **kwargs):
        calls.append(args)
        destination = Path(args[args.index('-d') + 1]) / m.PACKAGE
        destination.mkdir(parents=True)
        for name in m.ORACLE_SOURCES:
            (destination / (name + '.class')).write_bytes(b'fresh-different-oracle')
    with patch.object(m.subprocess, 'run', side_effect=fake_javac):
        try:
            m.prepare('dependencies.jar')
            raise AssertionError('stale oracle was accepted during preparation')
        except ValueError as error:
            assert 'oracle/helper classes differ' in str(error)
    assert len(calls) == 1
    print('PASS: four changed helper source/class checks and stale oracle preparation rejection')
with tempfile.TemporaryDirectory() as location:
    m = load('prepare-ha-fault-agent')
    root = Path(location)
    m.SERVICE = root
    m.OUTPUT = root / 'output'
    m.SERVICE_JAR = root / 'service.jar'
    m.TARGETS = {'Example': ('io/example/Example', 'InstrumentWriter', m.digest(b'reviewed source'))}
    source = root / 'src/main/java/io/example/Example.java'
    source.parent.mkdir(parents=True)
    source.write_bytes(b'reviewed source')
    m.JAVA_SOURCES = ()
    with zipfile.ZipFile(m.SERVICE_JAR, 'w') as jar:
        jar.writestr('BOOT-INF/classes/io/example/Example.class', b'stale packaged class')
    def fake_javac(args, **kwargs):
        destination = Path(args[args.index('-d') + 1])
        if destination.name == 'reference':
            output = destination / 'io/example/Example.class'
            output.parent.mkdir(parents=True)
            output.write_bytes(b'current compiled source')
    with patch.object(m.subprocess, 'run', side_effect=fake_javac):
        try:
            m.prepare()
            raise AssertionError('stale packaged class was accepted')
        except ValueError as error:
            assert 'Packaged class differs from reviewed source' in str(error)
    print('PASS: stale packaged class rejected before transformation')
