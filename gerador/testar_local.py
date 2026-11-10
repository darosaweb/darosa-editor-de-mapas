"""Coloca um mapa gerado no servidor de TESTE local (Docker) e deixa o Minecraft completar os chunks.

  python -I -X utf8 gerador/testar_local.py saida/teste-256

Passos: para o servidor de teste -> troca as regiões do overworld pelas do mapa -> liga ->
define spawn e borda do mundo -> força o carregamento de todos os chunks (o Minecraft roda
árvores, minérios, luz...) -> salva e desliga. Nunca toca na Pi.
"""
import json
import os
import shutil
import subprocess
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from anvil import Region  # noqa: E402
from rcon import wait_rcon  # noqa: E402

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVIDOR = os.path.join(RAIZ, 'teste-servidor')
OVERWORLD = os.path.join(SERVIDOR, 'dados', 'world', 'dimensions', 'minecraft', 'overworld')


def compose(*args):
    subprocess.run(['docker', 'compose', *args], cwd=SERVIDOR, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def statuses(info):
    """Conta os status dos chunks do mapa (desenho + anel) direto dos arquivos do servidor."""
    c = Counter()
    (x0, x1), (z0, z1) = info['chunks_x'], info['chunks_z']
    for name in info['regioes']:
        path = os.path.join(OVERWORLD, 'region', name)
        if not os.path.exists(path):
            continue
        r = Region(path)
        for lx, lz in r.chunks():
            cx, cz = r.rx * 32 + lx, r.rz * 32 + lz
            if x0 <= cx <= x1 and z0 <= cz <= z1:
                try:
                    c[r.chunk(lx, lz).get('Status')] += 1
                except Exception:
                    c['(ilegível durante a gravação)'] += 1
    return c


def main(saida):
    info = json.load(open(os.path.join(saida, 'info.json'), encoding='utf-8'))
    total = (info['chunks_x'][1] - info['chunks_x'][0] + 1) * (info['chunks_z'][1] - info['chunks_z'][0] + 1)

    print('1/5 parando o servidor de teste…')
    compose('stop')
    print('2/5 trocando o mundo de teste pelo mapa…')
    for sub in ('region', 'entities', 'poi'):
        shutil.rmtree(os.path.join(OVERWORLD, sub), ignore_errors=True)
    os.makedirs(os.path.join(OVERWORLD, 'region'))
    for name in info['regioes']:
        shutil.copy2(os.path.join(saida, 'region', name), os.path.join(OVERWORLD, 'region', name))

    print('3/5 ligando…')
    compose('start')
    r = wait_rcon(300)
    time.sleep(3)
    sx, sy, sz = info['spawn']
    print('   ', r.cmd(f'setworldspawn {sx} {sy} {sz}'))
    print('   ', r.cmd(f'worldborder center {info["borda_centro"][0]} {info["borda_centro"][1]}'))
    print('   ', r.cmd(f'worldborder set {info["borda_tamanho"]}'))

    print('4/5 completando os chunks (árvores, minérios, luz)…')
    (x0, x1), (z0, z1) = info['chunks_x'], info['chunks_z']
    for bz in range(z0, z1 + 1, 16):
        for bx in range(x0, x1 + 1, 16):
            ex, ez = min(bx + 15, x1), min(bz + 15, z1)
            r.cmd(f'forceload add {bx * 16} {bz * 16} {ex * 16 + 15} {ez * 16 + 15}')
    t0 = time.time()
    while True:
        time.sleep(10)
        r.cmd('save-all flush')
        st = statuses(info)
        full = st.get('minecraft:full', 0)
        print(f'    {time.time() - t0:5.0f}s  prontos {full}/{total}  {dict(st)}')
        if full >= total or time.time() - t0 > 900:
            break
    r.cmd('forceload remove all')
    r.cmd('save-all flush')
    time.sleep(2)
    print('5/5 desligando (o mundo fica salvo em teste-servidor/dados/world)…')
    try:
        r.cmd('stop')
    except Exception:
        pass
    r.close()
    for _ in range(60):
        out = subprocess.run(['docker', 'ps', '-q', '-f', 'name=minicraft-teste'], capture_output=True, text=True).stdout
        if not out.strip():
            break
        time.sleep(2)
    print('pronto:', dict(statuses(info)))


if __name__ == '__main__':
    main(sys.argv[1])
