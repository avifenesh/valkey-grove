#!/usr/bin/env python3
"""Own a six-primary development cluster and Grove. Never touches port 6379."""
import argparse
import binascii
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.local'
PORTS = range(7400, 7406)


def cli(port, *args):
    return subprocess.check_output(['valkey-cli', '-p', str(port), *args], text=True).strip()


def wait_until(probe, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if probe():
                return
        except (OSError, subprocess.SubprocessError):
            pass
        time.sleep(.1)
    raise RuntimeError('Readiness deadline exceeded')


def start():
    STATE.mkdir(exist_ok=True)
    if (STATE / 'cluster-ready').exists():
        if all(cli(p, 'PING') == 'PONG' for p in PORTS):
            print('Grove cluster is already running.')
            return
        raise RuntimeError('Some Grove nodes are stopped. Run stop, then start to restore all nodes.')
    # Check both client and cluster-bus ports before starting any process.
    for port in [*PORTS, *(p + 10000 for p in PORTS)]:
        with socket.socket() as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(('127.0.0.1', port))
    started = []
    try:
        for port in PORTS:
            directory = STATE / str(port)
            directory.mkdir(exist_ok=True)
            config = directory / 'valkey.conf'
            config.write_text(f'''port {port}
bind 127.0.0.1
protected-mode yes
daemonize yes
pidfile {directory}/valkey.pid
logfile {directory}/valkey.log
dir {directory}
cluster-enabled yes
cluster-config-file nodes.conf
cluster-node-timeout 5000
appendonly no
save ""
''')
            subprocess.run(['valkey-server', str(config)], check=True)
            started.append(port)
            wait_until(lambda: cli(port, 'PING') == 'PONG')
        if 'cluster_slots_assigned:16384' not in cli(7400, 'CLUSTER', 'INFO'):
            subprocess.run(['valkey-cli', '--cluster', 'create',
                            *(f'127.0.0.1:{p}' for p in PORTS),
                            '--cluster-replicas', '0', '--cluster-yes'], check=True)
        wait_until(lambda: all('cluster_state:ok' in cli(p, 'CLUSTER', 'INFO') for p in PORTS))
        (STATE / 'cluster-ready').touch()
    except Exception:
        for port in started:
            stop_node(port)
        raise


def command(sock, *args):
    args = [str(a).encode() for a in args]
    sock.sendall(b'*%d\r\n' % len(args) + b''.join(b'$%d\r\n' % len(a) + a + b'\r\n' for a in args))


def seed():
    if not (STATE / 'cluster-ready').exists():
        raise RuntimeError('Start the Grove cluster first.')
    topology = json.loads(cli(7400, '--json', 'CLUSTER', 'SLOTS'))
    sockets = {}
    try:
        for port in PORTS:
            sock = socket.create_connection(('127.0.0.1', port), timeout=3)
            sockets[port] = (sock, sock.makefile('rb'))
        namespaces = ['user', 'session', 'catalog', 'weather', 'event', 'garden']
        for i in range(12000):
            key = f'{namespaces[i % 6]}:{i}:profile'
            if i % 17 == 0:
                key = f'garden:{{plot-{i % 101}}}:plant:{i}'
            tag = key.split('{', 1)[1].split('}', 1)[0] if '{' in key else key
            slot = binascii.crc_hqx(tag.encode(), 0) % 16384
            port = next(row[2][1] for row in topology if row[0] <= slot <= row[1])
            sock, reader = sockets[port]
            command(sock, 'SET', key, 'Grove sample data')
            if reader.readline() != b'+OK\r\n':
                raise RuntimeError('Seeding failed')
        print('Seeded 12,000 sample keys into the real Valkey cluster.')
    finally:
        for sock, reader in sockets.values():
            reader.close()
            sock.close()


def stop_node(port):
    pidfile = STATE / str(port) / 'valkey.pid'
    if not pidfile.exists():
        return
    pid = int(pidfile.read_text().strip())
    try:
        cmdline = Path(f'/proc/{pid}/cmdline').read_bytes()
        if b'valkey-server' in cmdline and f':{port}'.encode() in cmdline:
            os.kill(pid, signal.SIGTERM)
            wait_until(lambda: not Path(f'/proc/{pid}').exists())
    except FileNotFoundError:
        pass


def stop():
    app_pid = STATE / 'grove.pid'
    if app_pid.exists():
        pid = int(app_pid.read_text())
        try:
            if Path(f'/proc/{pid}/exe').resolve() == ROOT / 'grove':
                os.kill(pid, signal.SIGTERM)
                wait_until(lambda: not Path(f'/proc/{pid}/exe').exists())
        except FileNotFoundError:
            pass
        app_pid.unlink(missing_ok=True)
    for port in PORTS:
        stop_node(port)
    (STATE / 'cluster-ready').unlink(missing_ok=True)
    print('Stopped Grove and its local cluster. Configuration is kept in .local/.')


def serve():
    STATE.mkdir(exist_ok=True)
    pidfile = STATE / 'grove.pid'
    if pidfile.exists():
        pid = int(pidfile.read_text())
        if Path(f'/proc/{pid}/exe').resolve() == ROOT / 'grove':
            print('Grove is already running at http://127.0.0.1:4187')
            return
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', 4187))
    subprocess.run(['go', 'build', '-o', 'grove', '.'], cwd=ROOT, check=True)
    with (STATE / 'grove.log').open('ab') as log:
        process = subprocess.Popen([str(ROOT / 'grove')], cwd=ROOT, stdout=log, stderr=log, start_new_session=True)
    pidfile.write_text(str(process.pid))
    try:
        wait_until(lambda: process.poll() is None and urllib.request.urlopen('http://127.0.0.1:4187/api/snapshot', timeout=20).status == 200)
    except Exception:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        pidfile.unlink(missing_ok=True)
        raise
    print('Valkey Grove is live at http://127.0.0.1:4187')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'seed', 'serve', 'up', 'stop'])
    action = parser.parse_args().action
    if action == 'up':
        start()
        seed()
        serve()
    else:
        globals()[action]()
