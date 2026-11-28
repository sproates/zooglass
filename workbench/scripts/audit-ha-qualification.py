#!/usr/bin/env python3
"""Audit retained HA case evidence; does not re-execute service assertions or controls."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat
import sys

MAX_BYTES = 16 * 1024 * 1024
CASE_IDS = list(range(1, 15))
# The reviewed preparation closure for this finite qualification, not arbitrary runs.
MODULES = {
    'ha-cases': 'binding-observation configuration context database-barrier manifest ordering-cases prepared process-cases proxy-cases run runner-support semantic-cases wire'.split(),
    'ha-fixture': 'barriers certificates cluster configuration docker images policy-delay proxy-health requests sidecar tcp-gate types'.split(),
    'service/ha': 'ownership producer protocol recovery transport viewer-state viewer'.split(),
    'json': ['lossless'],
}
WS_FILES = 'LICENSE README.md browser.js index.js package.json wrapper.mjs lib/buffer-util.js lib/constants.js lib/event-target.js lib/extension.js lib/limiter.js lib/permessage-deflate.js lib/receiver.js lib/sender.js lib/stream.js lib/subprotocol.js lib/validation.js lib/websocket-server.js lib/websocket.js'.split()
PREPARED_FILES = ({f'{root}/{component}/{name}.{extension}'
                  for component, names in MODULES.items() for name in names
                  for root, extension in [('src', 'ts'), ('dist', 'js')]}
                 | {f'dependency/ws/{name}' for name in WS_FILES}
                 | {'package-lock.json', 'tsconfig.json', 'scripts/prepare-ha.js'})
ORACLE_SOURCES = {'PostgresFenceControlsIT', 'PostgresFenceScenario',
                  'PostgresTestDatabase', 'HaStaticProfileTests'}
ORACLE_CLASSES = ({f'{name}.class' for name in ORACLE_SOURCES}
                  | {'PostgresFenceScenario$Observation.class', 'PostgresFenceScenario$Row.class'})


def require(condition, message):
    if not condition:
        raise ValueError(message)


def regular_bytes(path):
    require(stat.S_ISREG(path.lstat().st_mode), f"Not a regular file: {path}")
    require(path.stat().st_size <= MAX_BYTES, f"Evidence exceeds size bound: {path}")
    return path.read_bytes()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def decode(data):
    return json.loads(data, object_pairs_hook=unique_object,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"Invalid JSON number: {value}")))


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def valid_hash(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def check_identity(identity):
    require(isinstance(identity, dict) and set(identity) == {
        'format', 'node', 'platform', 'arch', 'head', 'images', 'files', 'service', 'faultAgent'},
        "Incomplete prepared identity")
    require(type(identity['format']) is int and identity['format'] == 1, "Unknown prepared identity format")
    require(isinstance(identity['head'], str) and re.fullmatch(r'[0-9a-f]{40}', identity['head']), "Invalid prepared commit")
    require(isinstance(identity['node'], str) and re.fullmatch(r'v26\.[0-9]+\.[0-9]+', identity['node']), "Invalid captured Node version")
    require(identity['platform'] in ('darwin', 'linux', 'win32') and identity['arch'] in ('arm64', 'x64'), "Invalid captured platform or architecture")
    require(isinstance(identity['images'], dict) and set(identity['images']) == {'postgres', 'jre', 'node', 'haproxy'}, "Incomplete image identities")
    for image in identity['images'].values():
        require(isinstance(image, str) and re.fullmatch(r'[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}', image), "Invalid pinned image digest")
    require(isinstance(identity['files'], dict) and set(identity['files']) == PREPARED_FILES,
            "Prepared file closure differs from the qualification inventory")
    require(all(valid_hash(value) for value in identity['files'].values()), "Invalid prepared file digest")
    for name in ('service', 'faultAgent'):
        artifact = identity[name]
        expected_keys = {'path', 'sha256'} | ({'manifestSha256'} if name == 'faultAgent' else set())
        require(isinstance(artifact, dict) and set(artifact) == expected_keys, "Incomplete artifact identity")
        require(isinstance(artifact['path'], str) and artifact['path'].strip(), "Missing artifact path")
        require(all(valid_hash(value) for key, value in artifact.items() if key != 'path'), "Invalid artifact digest")


def check_manifest(manifest):
    require(isinstance(manifest, list) and len(manifest) == 14, "Expected fourteen frozen cases")
    require([item['id'] for item in manifest] == CASE_IDS, "Frozen case IDs must be 1 through 14 in order")
    for item in manifest:
        require(type(item['id']) is int, "Case ID must be an integer")
        require(re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', item['name']), "Invalid frozen case name")
        require(type(item['timeoutMillis']) is int and item['timeoutMillis'] > 0, "Invalid case timeout")


def audit_run(directory, variation, manifest):
    require(directory.is_dir() and not directory.is_symlink(), f"Invalid evidence directory: {directory}")
    raw_report = regular_bytes(directory / 'report.json')
    report = decode(raw_report)
    require(report['format'] == 1 and report['purpose'] == 'bounded-real-fault-harness', "Unknown report format")
    require(report['status'] == 'passed', "Run did not pass")
    require(report['variation'] == variation, "Wrong run variation")
    require(report['pauseMillis'] == (75 if variation == 'extra-process-pauses' else 0), "Wrong pause duration")
    require(report['manifest'] == manifest, "Run differs from frozen manifest")
    results = report['results']
    require(len(results) == 14 and [item['id'] for item in results] == CASE_IDS, "Expected exactly fourteen ordered results")
    cases = []
    for expected, result in zip(manifest, results):
        case_id, name = expected['id'], expected['name']
        require(type(result['id']) is int and result['name'] == name, f"Case {case_id}: identity mismatch")
        require(result['status'] == 'passed' and result['phase'] == 'complete', f"Case {case_id}: incomplete or failed")
        require(result['failures'] == [] and result['cleanup'] == 'verified-absent', f"Case {case_id}: failure or uncertain cleanup")
        duration = result['durationMillis']
        require(type(duration) is int and duration >= 0, f"Case {case_id}: invalid duration")
        relative = f'case-{case_id:02d}-{name}/observations.jsonl'
        require(result['observationsPath'] == relative, f"Case {case_id}: unsafe or unexpected observation path")
        parent = directory / f'case-{case_id:02d}-{name}'
        require(parent.is_dir() and not parent.is_symlink(), f"Case {case_id}: invalid evidence directory")
        raw = regular_bytes(directory / relative)
        require(sha256(raw) == result['observationsSha256'], f"Case {case_id}: observation hash mismatch")
        require(raw.endswith(b'\n'), f"Case {case_id}: missing final newline")
        lines = raw.splitlines()
        require(type(result['observations']) is int and 0 < len(lines) <= 10000 and len(lines) == result['observations'], f"Case {case_id}: observation count mismatch")
        pauses, paused_processes = 0, 0
        timings = []
        for index, line in enumerate(lines, 1):
            observation = decode(line)
            require(observation['sequence'] == str(index), f"Case {case_id}: noncontiguous sequence")
            require(isinstance(observation['name'], str) and 0 < len(observation['name']) <= 128, f"Case {case_id}: invalid observation name")
            if observation['name'] in ('takeover', 'stable-origin-failover'):
                data = observation['data']
                expected_boundary = ('termination-request-to-successor-readiness'
                    if observation['name'] == 'takeover'
                    else 'termination-request-to-harness-confirmed-client-baseline')
                require(data['timingBoundary'] == expected_boundary, f"Case {case_id}: unknown timing boundary")
                require(isinstance(data['elapsedMillis'], str) and re.fullmatch(r'0|[1-9][0-9]*', data['elapsedMillis']), f"Case {case_id}: invalid recovery timing")
                require(int(data['elapsedMillis']) <= duration, f"Case {case_id}: recovery timing exceeds whole-case duration")
                timings.append({'observation': observation['name'], 'boundary': expected_boundary,
                                'elapsedMillis': int(data['elapsedMillis'])})
            if observation['name'] == 'extra-process-pause':
                data = observation['data']
                require(data['millis'] == '75' and data['processes'] in ('0', '1', '2'), f"Case {case_id}: invalid pause evidence")
                pauses += 1
                paused_processes += int(data['processes'])
        expected_timing_names = (['takeover'] if case_id in (2, 4, 5, 9, 10, 12, 13, 14) else [])
        if case_id in (13, 14):
            expected_timing_names.append('stable-origin-failover')
        require([timing['observation'] for timing in timings] == expected_timing_names,
                f"Case {case_id}: missing or unexpected recovery timing")
        if variation == 'normal':
            require(pauses == 0, f"Case {case_id}: unexpected extra pause")
        else:
            require(paused_processes > 0, f"Case {case_id}: no real process pause recorded")
        cases.append({'id': case_id, 'name': name, 'wholeCaseDurationMillis': duration,
                      'observations': len(lines), 'pauseObservations': pauses,
                      'pausedProcessOccurrences': paused_processes, 'observedRecoveryTimings': timings})
    return report['identity'], {'variation': variation, 'reportSha256': sha256(raw_report), 'cases': cases}


def audit_controls(directory, service_hash):
    require(directory.is_dir() and not directory.is_symlink(), "Invalid controls directory")
    manifest_bytes = regular_bytes(directory / 'manifest.json')
    results_bytes = regular_bytes(directory / 'results.json')
    manifest, results = decode(manifest_bytes), decode(results_bytes)
    require(type(manifest['format']) is int and manifest['format'] == 2, "Unknown controls manifest format")
    require(set(manifest) == {'format', 'authoritySha256', 'controls', 'oracleClasses',
            'oracleSources', 'preparerSha256', 'runtimeJarSha256', 'serviceJarSha256', 'sourceSha256'},
            "Incomplete controls manifest")
    for field in ('authoritySha256', 'preparerSha256', 'runtimeJarSha256', 'serviceJarSha256', 'sourceSha256'):
        require(valid_hash(manifest[field]), f"Invalid controls digest: {field}")
    require(set(manifest['controls']) == {'capture-owner', 'capture-revision'}, "Expected exactly two mutation identities")
    for control in manifest['controls'].values():
        require(set(control) == {'classSha256', 'sourceSha256'} and all(valid_hash(value) for value in control.values()), "Invalid mutation identity")
    require(len({manifest['authoritySha256'], *(control['classSha256'] for control in manifest['controls'].values())}) == 3,
            "Expected three distinct authority classes")
    for key, expected_keys in [('oracleSources', ORACLE_SOURCES), ('oracleClasses', ORACLE_CLASSES)]:
        require(set(manifest[key]) == expected_keys and all(valid_hash(value) for value in manifest[key].values()),
                f"Incomplete or invalid controls {key}")
    require(manifest['serviceJarSha256'] == results['serviceJarSha256'] == service_hash,
            "Controls used a different service JAR")
    require(manifest['runtimeJarSha256'] == results['runtimeJarSha256'], "Controls runtime JAR mismatch")
    expected = {(variant, scenario) for variant in ('production', 'capture-owner', 'capture-revision')
                for scenario in ('owner', 'revision')}
    require(len(results['runs']) == 6, "Expected six control outcomes")
    seen = set()
    for run in results['runs']:
        variant, observation = run['variant'], run['observation']
        scenario = observation['scenario']
        key = (variant, scenario)
        require(key in expected and key not in seen, "Unknown or duplicate control outcome")
        seen.add(key)
        class_hash = (manifest['authoritySha256'] if variant == 'production'
                      else manifest['controls'][variant]['classSha256'])
        require(observation['classSha256'] == class_hash, "Control class hash mismatch")
        must_fail = variant == f'capture-{scenario}'
        require(observation['invariantPassed'] is (not must_fail), "Wrong control invariant outcome")
        require(observation['captureResult'] == ('accepted' if must_fail else 'refused'), "Wrong control capture result")
        require(observation['invariant'] == ('former-owner-capture-refused' if scenario == 'owner'
                                            else 'stale-cache-capture-refused'), "Wrong control invariant")
        expected_state = (1, 2, 0, 0, True) if scenario == 'owner' else (1, 1, 0, 1, False)
        for field, value in zip(('capturedGeneration', 'databaseGeneration', 'cachedRevision',
                                 'databaseRevision', 'ownerChanged'), expected_state):
            require(type(observation[field]) is type(value) and observation[field] == value,
                    "Control precondition mismatch")
    return {'manifestSha256': sha256(manifest_bytes), 'resultsSha256': sha256(results_bytes),
            'outcomes': 6, 'mutantViolationsDetected': 2}


def audit(normal, paused, manifest_path, controls_path, identity_path):
    manifest_bytes = regular_bytes(manifest_path)
    manifest = decode(manifest_bytes)
    check_manifest(manifest)
    normal_identity, normal_summary = audit_run(normal, 'normal', manifest)
    paused_identity, paused_summary = audit_run(paused, 'extra-process-pauses', manifest)
    identity_bytes = regular_bytes(identity_path)
    frozen_identity = decode(identity_bytes)
    check_identity(frozen_identity)
    require(normal_identity == paused_identity == frozen_identity,
            "Prepared identities differ from the frozen identity")
    return {'format': 1, 'status': 'passed', 'auditScope': 'case-evidence-consistency',
            'executions': 28, 'head': normal_identity['head'],
            'controls': audit_controls(controls_path, normal_identity['service']['sha256']),
            'manifestSha256': sha256(manifest_bytes),
            'preparedIdentitySha256': sha256(identity_bytes),
            'limits': ['Does not re-execute semantic assertions or negative controls.',
                       'Durations include setup and cleanup; they are not failover latency.',
                       'Hashes establish consistency, not authenticity.'],
            'runs': [normal_summary, paused_summary]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('normal', type=Path)
    parser.add_argument('paused', type=Path)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--controls', required=True, type=Path)
    parser.add_argument('--identity', required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(audit(args.normal, args.paused, args.manifest, args.controls, args.identity), indent=2))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'HA evidence audit failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
