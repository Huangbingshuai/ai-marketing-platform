"""Add this site's gateway references without rewriting other YAML content."""

from __future__ import annotations

import copy
import datetime
import os
from pathlib import Path
import re
import sys

import yaml

ROOT = Path('/opt/ai-marketing-platform')
BACKUPS = ROOT / 'deployment-logs' / 'domain-backups'


def service_block(source: str, name: str) -> tuple[int, int, str]:
    match = re.search(rf'^  {re.escape(name)}:\s*\n', source, re.MULTILINE)
    if not match:
        raise RuntimeError(f'Missing service: {name}')
    rest = source[match.end():]
    end = re.search(r'^(?:  [A-Za-z0-9_-]+:|[^\s#])', rest, re.MULTILINE)
    stop = match.end() + end.start() if end else len(source)
    return match.start(), stop, source[match.start():stop]


def save(path: Path, original: str, updated: str, expected: dict) -> None:
    if yaml.safe_load(updated) != expected:
        raise RuntimeError(f'Unexpected YAML change: {path.name}')
    if updated == original:
        print(f'Already configured: {path.name}')
        return
    BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
    BACKUPS.chmod(0o700)
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = BACKUPS / f'{path.name}.{timestamp}.bak'
    with backup.open('x', encoding='utf-8') as handle:
        os.chmod(backup, 0o600)
        handle.write(original)
    path.write_text(updated, encoding='utf-8')
    print(f'Configured: {path.name}; backup saved with restricted permissions')


def configure_http() -> None:
    path = Path('/root/lens-rhyme-deployment-cd/compose/docker-compose.overseas-production.yml')
    original = path.read_text()
    expected = copy.deepcopy(yaml.safe_load(original))
    reference = {'source': 'marketing_nginx_config', 'target': '/etc/nginx/conf.d/marketing.conf'}
    configs = expected['services']['nginx']['configs']
    config_path = {'file': str(ROOT / 'deploy/domain/marketing-http.conf')}
    if reference in configs:
        if expected['configs'].get('marketing_nginx_config') != config_path:
            raise RuntimeError('Conflicting marketing HTTP configuration')
        print('HTTP gateway already configured')
        return
    configs.insert(0, reference)
    if 'marketing_nginx_config' in expected['configs']:
        raise RuntimeError('Conflicting marketing HTTP configuration')
    expected['configs']['marketing_nginx_config'] = config_path
    start, stop, block = service_block(original, 'nginx')
    block = block.replace('    configs:\n', '    configs:\n      - source: marketing_nginx_config\n        target: /etc/nginx/conf.d/marketing.conf\n', 1)
    updated = original[:start] + block + original[stop:]
    updated = re.sub(r'^configs:\s*\n', 'configs:\n  marketing_nginx_config:\n    file: /opt/ai-marketing-platform/deploy/domain/marketing-http.conf\n', updated, count=1, flags=re.MULTILINE)
    save(path, original, updated, expected)


def configure_https() -> None:
    path = Path('/opt/avatar-proxy/releases/20260903-wechat-callback-584c1f1/deploy/volcengine/compose.yaml')
    original = path.read_text()
    expected = copy.deepcopy(yaml.safe_load(original))
    service = expected['services']['api-gateway']
    volume = '/opt/ai-marketing-platform/deploy/domain/marketing-https.conf:/etc/nginx/conf.d/marketing.conf:ro'
    network = {'external': True, 'name': 'richi-marketing_default'}
    if volume in service.get('volumes', []):
        if service.get('networks') != ['default', 'marketing'] or expected.get('networks', {}).get('marketing') != network:
            raise RuntimeError('Conflicting marketing HTTPS configuration')
        print('HTTPS gateway already configured')
        return
    if service.get('networks') or expected.get('networks'):
        raise RuntimeError('Gateway networks changed; review before applying')
    service['volumes'].insert(0, volume)
    service['networks'] = ['default', 'marketing']
    expected['networks'] = {'marketing': network}
    start, stop, block = service_block(original, 'api-gateway')
    block = block.replace('    volumes:\n', f'    volumes:\n      - {volume}\n', 1)
    block += '    networks:\n      - default\n      - marketing\n'
    updated = original[:start] + block + original[stop:]
    updated += '\nnetworks:\n  marketing:\n    external: true\n    name: richi-marketing_default\n'
    save(path, original, updated, expected)


if __name__ == '__main__':
    {'http': configure_http, 'https': configure_https}[sys.argv[1]]()
