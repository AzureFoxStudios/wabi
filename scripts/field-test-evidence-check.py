#!/usr/bin/env python3
"""Check required fields and evidence links in a Wabi field scenario manifest.

This checks report completeness, not whether a claimed behavior happened.
Unavailable measurements must be explicit; they are never filled with zero.
"""
import argparse
import json
from pathlib import Path


def check(document, repository):
    errors = []
    required = ['run_id', 'machines', 'networks', 'builds', 'layout', 'routes',
                'steps', 'expected', 'actual', 'status', 'evidence', 'limitations',
                'measurement_sufficiency']
    statuses = {'PASS', 'FAIL', 'BLOCKED', 'NOT TESTED'}
    seen = set()
    for index, scenario in enumerate(document.get('scenarios', [])):
        label = scenario.get('run_id', f'row {index}')
        if label in seen:
            errors.append(f'{label}: duplicate run ID')
        seen.add(label)
        for field in required:
            if field not in scenario or scenario[field] is None:
                errors.append(f'{label}: missing {field}')
        if scenario.get('status') not in statuses:
            errors.append(f'{label}: invalid status')
        for evidence in scenario.get('evidence', []):
            path = repository / evidence
            if not path.is_file():
                errors.append(f'{label}: missing evidence file {evidence}')
        if scenario.get('status') == 'PASS' and not scenario.get('evidence'):
            errors.append(f'{label}: PASS has no retained evidence')
        for field in ['authority_access', 'media_backend', 'tailcat_path', 'helper']:
            if field not in scenario.get('routes', {}):
                errors.append(f'{label}: missing route observation {field}')
    if not document.get('scenarios'):
        errors.append('no scenarios')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    data = json.loads(args.manifest.read_text())
    errors = check(data, args.repository)
    print(json.dumps({'complete': not errors, 'scenario_count': len(data.get('scenarios', [])),
                      'errors': errors, 'limits': 'Completeness only; not independent functional proof.'}, indent=2))
    raise SystemExit(bool(errors))


if __name__ == '__main__':
    main()
