"""Offline qualification checks reject incomplete or inconsistent retained evidence."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/audit-ha-qualification.py'
SPEC = importlib.util.spec_from_file_location('ha_audit', SCRIPT)
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class QualificationAuditTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.controls = self.root / 'controls'
        self.controls.mkdir()
        (self.controls / 'manifest.json').write_text(json.dumps({
            'format': 2, 'serviceJarSha256': digest('service'), 'runtimeJarSha256': digest('runtime'),
            'authoritySha256': digest('production-class'),
            'sourceSha256': digest('authority-source'), 'preparerSha256': digest('preparer'),
            'oracleSources': {name: digest(name) for name in AUDIT.ORACLE_SOURCES},
            'oracleClasses': {name: digest(name) for name in AUDIT.ORACLE_CLASSES},
            'controls': {'capture-owner': {'classSha256': digest('owner-class'), 'sourceSha256': digest('owner-source')},
                         'capture-revision': {'classSha256': digest('revision-class'), 'sourceSha256': digest('revision-source')}}}))
        control_runs = []
        for variant, class_hash in [('production', digest('production-class')),
                                   ('capture-owner', digest('owner-class')), ('capture-revision', digest('revision-class'))]:
            for scenario in ('owner', 'revision'):
                fails = variant == f'capture-{scenario}'
                control_runs.append({'variant': variant, 'observation': {
                    'scenario': scenario, 'classSha256': class_hash,
                    'capturedGeneration': 1, 'databaseGeneration': 2 if scenario == 'owner' else 1,
                    'cachedRevision': 0, 'databaseRevision': 0 if scenario == 'owner' else 1,
                    'ownerChanged': scenario == 'owner',
                    'captureResult': 'accepted' if fails else 'refused', 'invariantPassed': not fails,
                    'invariant': 'former-owner-capture-refused' if scenario == 'owner' else 'stale-cache-capture-refused'}})
        (self.controls / 'results.json').write_text(json.dumps({
            'serviceJarSha256': digest('service'), 'runtimeJarSha256': digest('runtime'), 'runs': control_runs}))
        self.manifest = [{'id': i, 'name': f'case-{i}', 'timeoutMillis': 180000}
                         for i in range(1, 15)]
        self.manifest_path = self.root / 'manifest.json'
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.identity_path = self.root / 'identity.json'
        self.identity = {'format': 1, 'head': 'a' * 40, 'node': 'v26.0.0',
                         'platform': 'linux', 'arch': 'arm64',
                         'images': {name: f'{name}:1@sha256:{digest(name)}'
                                    for name in ('postgres', 'jre', 'node', 'haproxy')},
                         'files': {name: digest(name) for name in AUDIT.PREPARED_FILES},
                         'service': {'path': '/prepared/zooglass.jar', 'sha256': digest('service')},
                         'faultAgent': {'path': '/prepared/agent.jar', 'sha256': digest('agent'),
                                        'manifestSha256': digest('agent-manifest')}}
        self.identity_path.write_text(json.dumps(self.identity))
        for variation, directory in [('normal', 'normal'), ('extra-process-pauses', 'paused')]:
            folder = self.root / directory
            folder.mkdir()
            report = {'format': 1, 'purpose': 'bounded-real-fault-harness', 'status': 'passed',
                      'variation': variation, 'pauseMillis': 0 if directory == 'normal' else 75,
                      'manifest': self.manifest,
                      'identity': self.identity,
                      'results': []}
            for case in self.manifest:
                observations = [{'sequence': '1', 'name': 'expected-state', 'data': {}}]
                if case['id'] in (2, 4, 5, 9, 10, 12, 13, 14):
                    observations.append({'sequence': str(len(observations) + 1), 'name': 'takeover',
                        'data': {'elapsedMillis': '42', 'timingBoundary': 'termination-request-to-successor-readiness'}})
                if case['id'] in (13, 14):
                    observations.append({'sequence': str(len(observations) + 1), 'name': 'stable-origin-failover',
                        'data': {'elapsedMillis': '43', 'timingBoundary': 'termination-request-to-harness-confirmed-client-baseline'}})
                if directory == 'paused':
                    observations.append({'sequence': str(len(observations) + 1), 'name': 'extra-process-pause',
                                         'data': {'millis': '75', 'processes': '2'}})
                path = f"case-{case['id']:02d}-{case['name']}/observations.jsonl"
                (folder / path).parent.mkdir()
                raw = ''.join(json.dumps(item) + '\n' for item in observations).encode()
                (folder / path).write_bytes(raw)
                report['results'].append({'id': case['id'], 'name': case['name'], 'status': 'passed',
                    'phase': 'complete', 'failures': [], 'cleanup': 'verified-absent',
                    'durationMillis': 1234, 'observationsPath': path,
                    'observationsSha256': hashlib.sha256(raw).hexdigest(),
                    'observations': len(observations)})
            (folder / 'report.json').write_text(json.dumps(report))

    def report(self, directory='normal'):
        return json.loads((self.root / directory / 'report.json').read_text())

    def write_report(self, report, directory='normal'):
        (self.root / directory / 'report.json').write_text(json.dumps(report))

    def audit(self):
        return AUDIT.audit(self.root / 'normal', self.root / 'paused', self.manifest_path, self.controls, self.identity_path)

    def mutate_observations(self, mutation, directory='normal'):
        report = self.report(directory)
        result = report['results'][0]
        path = self.root / directory / result['observationsPath']
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        mutation(rows)
        raw = ''.join(json.dumps(item) + '\n' for item in rows).encode()
        path.write_bytes(raw)
        result['observationsSha256'] = hashlib.sha256(raw).hexdigest()
        result['observations'] = len(rows)
        self.write_report(report, directory)

    def test_complete_pair_and_duration_meaning(self):
        result = self.audit()
        self.assertEqual(result['executions'], 28)
        self.assertEqual(result['runs'][0]['cases'][0]['wholeCaseDurationMillis'], 1234)
        self.assertIn('not failover latency', result['limits'][1])

    def test_recovery_timing_is_separate_from_case_duration(self):
        timing = self.audit()['runs'][0]['cases'][1]['observedRecoveryTimings'][0]
        self.assertEqual(timing['elapsedMillis'], 42)
        self.assertEqual(self.audit()['runs'][0]['cases'][1]['wholeCaseDurationMillis'], 1234)

    def test_missing_recovery_timing_rejected(self):
        report = self.report()
        result = report['results'][1]
        path = self.root / 'normal' / result['observationsPath']
        raw = (path.read_text().splitlines()[0] + '\n').encode()
        path.write_bytes(raw)
        result['observationsSha256'] = hashlib.sha256(raw).hexdigest()
        result['observations'] = 1
        self.write_report(report)
        with self.assertRaisesRegex(ValueError, 'recovery timing'):
            self.audit()

    def test_controls_require_exact_six_outcomes_and_matching_artifact(self):
        path = self.controls / 'results.json'
        original = json.loads(path.read_text())
        for change in ('missing', 'duplicate', 'invariant', 'artifact', 'class'):
            with self.subTest(change=change):
                result = json.loads(json.dumps(original))
                if change == 'missing':
                    result['runs'].pop()
                elif change == 'duplicate':
                    result['runs'][-1] = result['runs'][0]
                elif change == 'invariant':
                    result['runs'][2]['observation']['invariantPassed'] = True
                elif change == 'artifact':
                    result['serviceJarSha256'] = 'other'
                else:
                    result['runs'][0]['observation']['classSha256'] = 'other'
                path.write_text(json.dumps(result))
                with self.assertRaises(ValueError):
                    self.audit()

    def test_frozen_identity_rejects_both_reports_changed_together(self):
        for directory in ('normal', 'paused'):
            report = self.report(directory)
            report['identity']['head'] = 'b' * 40
            self.write_report(report, directory)
        with self.assertRaisesRegex(ValueError, 'frozen identity'):
            self.audit()

    def test_identity_requires_complete_valid_prepared_closure(self):
        for change in ('node', 'platform', 'image', 'file', 'file-hash', 'artifact'):
            with self.subTest(change=change):
                identity = json.loads(json.dumps(self.identity))
                if change == 'node':
                    identity['node'] = 'v25.0.0'
                elif change == 'platform':
                    identity['platform'] = ''
                elif change == 'image':
                    identity['images']['node'] = 'node:26'
                elif change == 'file':
                    identity['files'].pop('src/ha-cases/run.ts')
                elif change == 'file-hash':
                    identity['files']['src/ha-cases/run.ts'] = 'bad'
                else:
                    identity['faultAgent'].pop('manifestSha256')
                self.identity_path.write_text(json.dumps(identity))
                with self.assertRaises(ValueError):
                    self.audit()

    def test_controls_require_complete_distinct_mutation_and_oracle_identities(self):
        path = self.controls / 'manifest.json'
        original = json.loads(path.read_text())
        for change in ('mutation', 'same-class', 'preparer', 'oracle-source', 'oracle-class'):
            with self.subTest(change=change):
                manifest = json.loads(json.dumps(original))
                if change == 'mutation':
                    manifest['controls']['extra'] = manifest['controls']['capture-owner']
                elif change == 'same-class':
                    manifest['controls']['capture-owner']['classSha256'] = manifest['authoritySha256']
                elif change == 'preparer':
                    manifest['preparerSha256'] = 'bad'
                elif change == 'oracle-source':
                    manifest['oracleSources'].pop('HaStaticProfileTests')
                else:
                    manifest['oracleClasses']['extra.class'] = digest('extra')
                path.write_text(json.dumps(manifest))
                with self.assertRaises(ValueError):
                    self.audit()

    def test_recovery_timing_cannot_exceed_case_duration(self):
        report = self.report()
        report['results'][1]['durationMillis'] = 41
        self.write_report(report)
        with self.assertRaisesRegex(ValueError, 'exceeds whole-case'):
            self.audit()

    def test_failed_missing_and_unclean_cases(self):
        original = self.report()
        for field, value in [('status', 'failed'), ('phase', 'scenario'),
                             ('cleanup', 'no-resources-created'), ('failures', [{'message': 'bad'}])]:
            with self.subTest(field=field):
                report = json.loads(json.dumps(original))
                report['results'][0][field] = value
                self.write_report(report)
                with self.assertRaises(ValueError):
                    self.audit()
        original['results'].pop()
        self.write_report(original)
        with self.assertRaisesRegex(ValueError, 'fourteen'):
            self.audit()

    def test_changed_manifest_and_identity(self):
        report = self.report('paused')
        report['manifest'][0]['name'] = 'changed'
        self.write_report(report, 'paused')
        with self.assertRaisesRegex(ValueError, 'frozen manifest'):
            self.audit()
        report['manifest'] = self.manifest
        report['identity']['head'] = 'b' * 40
        self.write_report(report, 'paused')
        with self.assertRaisesRegex(ValueError, 'identities differ'):
            self.audit()

    def test_corrupted_observation_hash(self):
        report = self.report()
        (self.root / 'normal' / report['results'][0]['observationsPath']).write_text('{}\n')
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            self.audit()

    def test_sequence_checked_even_with_updated_hash(self):
        self.mutate_observations(lambda rows: rows[0].update(sequence='2'))
        with self.assertRaisesRegex(ValueError, 'noncontiguous'):
            self.audit()

    def test_pause_must_reach_a_process(self):
        self.mutate_observations(lambda rows: rows[1]['data'].update(processes='0'), 'paused')
        with self.assertRaisesRegex(ValueError, 'no real process pause'):
            self.audit()

    def test_normal_run_cannot_contain_extra_pauses(self):
        self.mutate_observations(lambda rows: rows.append({'sequence': '2',
            'name': 'extra-process-pause', 'data': {'millis': '75', 'processes': '1'}}))
        with self.assertRaisesRegex(ValueError, 'unexpected extra pause'):
            self.audit()

    def test_unsafe_path_and_symlink_rejected(self):
        report = self.report()
        original_path = report['results'][0]['observationsPath']
        report['results'][0]['observationsPath'] = '../secret'
        self.write_report(report)
        with self.assertRaisesRegex(ValueError, 'unsafe'):
            self.audit()
        report['results'][0]['observationsPath'] = original_path
        self.write_report(report)
        path = self.root / 'normal' / original_path
        contents = path.read_bytes()
        path.unlink()
        target = self.root / 'outside'
        target.write_bytes(contents)
        path.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'regular file'):
            self.audit()

    def test_duplicate_json_key_rejected(self):
        path = self.root / 'normal/report.json'
        path.write_text(path.read_text().replace('"format": 1', '"format": 1, "format": 1', 1))
        with self.assertRaisesRegex(ValueError, 'Duplicate JSON key'):
            self.audit()


if __name__ == '__main__':
    unittest.main()
