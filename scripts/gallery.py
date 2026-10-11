#!/usr/bin/env python3
"""Capture three real key distributions in a temporary, owned Valkey cluster."""
import argparse
import binascii
from collections import Counter
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
KEY_COUNT = 12000


def slot(key):
    start = key.find('{')
    end = key.find('}', start + 1) if start >= 0 else -1
    if end > start + 1:
        key = key[start + 1:end]
    return binascii.crc_hqx(key.encode(), 0) & 16383


def keys_for(pattern):
    if pattern == 'uniform':
        return [f'grove:uniform:item:{i}' for i in range(KEY_COUNT)]
    if pattern == 'hash-tags':
        return [f'grove:{{tenant-{i % 24}}}:item:{i}' for i in range(KEY_COUNT)]
    if pattern == 'hot-node':
        # Distinct keys spread over many slots, selected to put 90% on node 01.
        hot, rest, candidate = [], [], 0
        while len(hot) < 10800 or len(rest) < 1200:
            key = f'grove:hot-node:item:{candidate}'
            target, size = (hot, 10800) if slot(key) <= 2730 else (rest, 1200)
            if len(target) < size:
                target.append(key)
            candidate += 1
        return hot + rest
    raise ValueError(pattern)


def wait_ready(probe, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = probe()
            if result:
                return result
        except (OSError, urllib.error.URLError, subprocess.SubprocessError):
            pass
        time.sleep(.1)
    raise RuntimeError('Readiness deadline exceeded')


def terminate(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def cli(port, *args):
    return subprocess.check_output(['valkey-cli', '-p', str(port), *args],
                                   text=True, stderr=subprocess.DEVNULL, timeout=5).strip()


def write_command(sock, *args):
    encoded = [str(a).encode() for a in args]
    sock.sendall(b'*%d\r\n' % len(encoded) + b''.join(
        b'$%d\r\n' % len(a) + a + b'\r\n' for a in encoded))


def read_response(reader):
    line = reader.readline()
    if not line.endswith(b'\r\n'):
        raise RuntimeError('Incomplete Valkey response')
    if line.startswith(b'+'):
        return line[1:-2].decode()
    if line.startswith(b'$'):
        size = int(line[1:-2])
        if size < 0:
            raise RuntimeError('Unexpected null Valkey response')
        data = reader.read(size + 2)
        if len(data) != size + 2 or not data.endswith(b'\r\n'):
            raise RuntimeError('Incomplete Valkey bulk response')
        return data[:-2].decode()
    raise RuntimeError('Unexpected Valkey response')


def owns_endpoint(port, process):
    if process.poll() is not None:
        raise RuntimeError(f'Owned gallery node {port} stopped')
    info = cli(port, 'INFO', 'server')
    fields = dict(line.split(':', 1) for line in info.splitlines() if ':' in line)
    if fields.get('process_id') != str(process.pid):
        raise RuntimeError(f'Port {port} does not belong to this gallery run')
    return True


def populate(ports, processes, topology, keys):
    with ExitStack() as stack:
        connections = {}
        for port in ports:
            sock = stack.enter_context(socket.create_connection(('127.0.0.1', port), timeout=5))
            reader = stack.enter_context(sock.makefile('rb'))
            write_command(sock, 'INFO', 'server')
            fields = dict(line.split(':', 1) for line in read_response(reader).splitlines() if ':' in line)
            if processes[port].poll() is not None or fields.get('process_id') != str(processes[port].pid):
                raise RuntimeError(f'Refusing to change unowned node on port {port}')
            # Identity is checked on the same connection used for every write.
            write_command(sock, 'FLUSHDB')
            if read_response(reader) != 'OK':
                raise RuntimeError('Could not reset owned gallery node')
            connections[port] = sock, reader
        for key in keys:
            hashed = slot(key)
            port = next(row[2][1] for row in topology if row[0] <= hashed <= row[1])
            sock, reader = connections[port]
            write_command(sock, 'SET', key, 'Synthetic gallery data')
            if read_response(reader) != 'OK':
                raise RuntimeError('SET failed in the gallery cluster')


def snapshot(binary, seed_port, http_port, log):
    env = os.environ.copy()
    env.pop('VALKEY_USERNAME', None)
    env.pop('VALKEY_PASSWORD', None)
    # Each primary can contribute all 12,000 keys, including the hotspot case.
    process = subprocess.Popen([str(binary), '-cluster', f'127.0.0.1:{seed_port}',
                                '-listen', f'127.0.0.1:{http_port}', '-sample', '72000'],
                               stdout=log, stderr=log, env=env)
    try:
        def read():
            if process.poll() is not None:
                raise RuntimeError('Gallery collector stopped before readiness')
            with urllib.request.urlopen(f'http://127.0.0.1:{http_port}/api/snapshot', timeout=20) as r:
                return json.load(r)
        return wait_ready(read)
    finally:
        terminate(process)


def capture(output, base_port, http_port):
    ports = list(range(base_port, base_port + 6))
    for port in [*ports, *(p + 10000 for p in ports), http_port]:
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(('127.0.0.1', port))
    output.mkdir(parents=True, exist_ok=True)
    cache = Path.home() / '.cache'
    cache.mkdir(exist_ok=True)
    receipts = {'keyCount': KEY_COUNT, 'primaries': 6, 'scenarios': []}
    with tempfile.TemporaryDirectory(prefix='valkey-grove-gallery-', dir=cache) as temp:
        temp = Path(temp)
        binary = temp / 'grove'
        subprocess.run(['go', 'build', '-o', str(binary), '.'], cwd=ROOT, check=True, timeout=120)
        with ExitStack() as stack:
            processes = {}
            for port in ports:
                node_dir = temp / str(port)
                node_dir.mkdir()
                log = stack.enter_context((node_dir / 'server.log').open('wb'))
                process = subprocess.Popen(['valkey-server', '--port', str(port),
                    '--bind', '127.0.0.1', '--protected-mode', 'yes', '--dir', str(node_dir),
                    '--cluster-enabled', 'yes', '--cluster-config-file', 'nodes.conf',
                    '--cluster-node-timeout', '5000', '--save', '', '--appendonly', 'no'],
                    stdout=log, stderr=log)
                processes[port] = process
                stack.callback(terminate, process)
            for port in ports:
                wait_ready(lambda p=port: owns_endpoint(p, processes[p]))
            subprocess.run(['valkey-cli', '--cluster', 'create',
                *(f'127.0.0.1:{p}' for p in ports), '--cluster-replicas', '0', '--cluster-yes'],
                check=True, timeout=30, stdout=subprocess.DEVNULL)
            wait_ready(lambda: all('cluster_state:ok' in cli(p, 'CLUSTER', 'INFO') for p in ports))
            topology = json.loads(cli(ports[0], '--json', 'CLUSTER', 'SLOTS'))
            log = stack.enter_context((temp / 'collector.log').open('wb'))
            for pattern in ('uniform', 'hot-node', 'hash-tags'):
                keys = keys_for(pattern)
                populate(ports, processes, topology, keys)
                data = snapshot(binary, ports[0], http_port, log)
                if not data['complete'] or len(data['keys']) != KEY_COUNT:
                    raise RuntimeError(f'Incomplete {pattern} capture')
                observed = {key['name']: key for key in data['keys']}
                if set(observed) != set(keys) or any(observed[k]['slot'] != slot(k) for k in keys):
                    raise RuntimeError(f'Key identity or slot mismatch in {pattern}')
                # Verify every key was observed on the node responsible for its slot.
                if any(not any(a <= key['slot'] <= b for a, b in data['nodes'][key['node']]['slots'])
                       for key in data['keys']):
                    raise RuntimeError(f'Key ownership mismatch in {pattern}')
                data['source'] = 'snapshot'
                encoded = json.dumps(data, separators=(',', ':')).encode()
                (output / f'{pattern}.json').write_bytes(encoded)
                counts = Counter(key['node'] for key in data['keys'])
                receipt = {'name': pattern, 'capturedAt': data['capturedAt'],
                    'keys': len(keys), 'occupiedSlots': len({key['slot'] for key in data['keys']}),
                    'nodeKeys': [n['keys'] for n in data['nodes']],
                    'observedNodeKeys': [counts[i] for i in range(len(data['nodes']))],
                    'sha256': hashlib.sha256(encoded).hexdigest(),
                    'captureSampleLimit': data['sampleLimit'], 'complete': True}
                receipts['scenarios'].append(receipt)
                print(json.dumps(receipt), flush=True)
        (output / 'receipts.json').write_text(json.dumps(receipts, indent=2) + '\n')
    print(f'Snapshots: {output}. Temporary cluster removed.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / '.local/gallery')
    parser.add_argument('--base-port', type=int, default=7600)
    parser.add_argument('--http-port', type=int, default=4188)
    args = parser.parse_args()
    capture(args.output.resolve(), args.base_port, args.http_port)
