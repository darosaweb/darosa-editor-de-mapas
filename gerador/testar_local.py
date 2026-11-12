"""Coloca um mapa gerado no servidor de TESTE local (Docker) e deixa o Minecraft completar os chunks.

  python -I -X utf8 gerador/testar_local.py saida/teste-256

Passos: para o servidor de teste -> troca as regiões do overworld pelas do mapa -> liga ->
define spawn e borda do mundo -> força o carregamento de todos os chunks (o Minecraft roda
árvores, minérios, luz...) -> salva e desliga. Nunca toca na Pi.
"""
import json
import math
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


MUNDO = os.path.join(SERVIDOR, 'dados', 'world')


def regioes_de(x0, x1, z0, z1):
    return sorted({f'r.{cx >> 5}.{cz >> 5}.mca' for cx in range(x0, x1 + 1) for cz in range(z0, z1 + 1)})


def statuses(info, pasta=OVERWORLD):
    """Conta os status dos chunks do mapa (desenho + anel) direto dos arquivos do servidor."""
    c = Counter()
    (x0, x1), (z0, z1) = info['chunks_x'], info['chunks_z']
    for name in info.get('regioes') or regioes_de(x0, x1, z0, z1):
        path = os.path.join(pasta, 'region', name)
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


def forcar_carregar(r, dim, x0, x1, z0, z1):
    """forceload em blocos de até 16x16 chunks (limite do comando)."""
    pre = '' if dim == 'overworld' else f'execute in minecraft:{dim} run '
    for bz in range(z0, z1 + 1, 16):
        for bx in range(x0, x1 + 1, 16):
            ex, ez = min(bx + 15, x1), min(bz + 15, z1)
            r.cmd(f'{pre}forceload add {bx * 16} {bz * 16} {ex * 16 + 15} {ez * 16 + 15}')


def esperar_prontos(r, info_dim, pasta, rotulo, limite=900):
    total = (info_dim['chunks_x'][1] - info_dim['chunks_x'][0] + 1) * (info_dim['chunks_z'][1] - info_dim['chunks_z'][0] + 1)
    t0 = time.time()
    while True:
        time.sleep(10)
        r.cmd('save-all flush')
        st = statuses(info_dim, pasta)
        full = st.get('minecraft:full', 0)
        print(f'    {rotulo}: {time.time() - t0:5.0f}s  prontos {full}/{total}')
        if full >= total or time.time() - t0 > limite:
            return full, total


def pregerar(r, dim, borda, margem=6):
    """Gera no PC a parte central do Nether/End que fica dentro da borda (+ margem para a distância de visão)."""
    raio = math.ceil(borda / 2 / 16) + margem
    info_dim = {'chunks_x': [-raio, raio - 1], 'chunks_z': [-raio, raio - 1], 'borda': borda}
    pre = f'execute in minecraft:{dim} run '
    r.cmd(pre + 'worldborder center 0 0')
    r.cmd(pre + f'worldborder set {borda}')
    print('   ', dim, '->', r.cmd(pre + 'worldborder get').strip())
    forcar_carregar(r, dim, -raio, raio - 1, -raio, raio - 1)
    full, total = esperar_prontos(r, info_dim, os.path.join(MUNDO, 'dimensions', 'minecraft', dim), dim)
    r.cmd(pre + 'forceload remove all')
    info_dim['prontos'] = f'{full}/{total}'
    return info_dim


def main(saida, mundo_novo=False):
    info = json.load(open(os.path.join(saida, 'info.json'), encoding='utf-8'))

    print('1/5 parando o servidor de teste…')
    compose('stop')
    if mundo_novo:
        print('2/5 apagando o mundo de teste inteiro (mundo novo) e colocando o mapa…')
        shutil.rmtree(MUNDO, ignore_errors=True)
    else:
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
    forcar_carregar(r, 'overworld', x0, x1, z0, z1)
    esperar_prontos(r, info, OVERWORLD, 'mundo de cima')
    # vilas marcadas no editor: o próprio Minecraft constrói (casas, caminhos, aldeões)
    vilas = info.get('vilas') or []
    resultado_vilas = []
    for v in vilas:
        resp = r.cmd(f'place structure {v["estrutura"]} {v["x"]} {v["y"]} {v["z"]}')
        ok = 'Generated' in resp or 'gerad' in resp.lower()
        resultado_vilas.append({**v, 'ok': ok, 'resposta': resp.strip()})
        print(f'    vila {v["estrutura"]} em X {v["x"]} Z {v["z"]}: {"✓" if ok else "✗ " + resp.strip()}')
    if vilas:
        time.sleep(5)          # deixa o servidor terminar de colocar as peças das vilas
        r.cmd('save-all flush')
    info['vilas_resultado'] = resultado_vilas

    if mundo_novo:
        # Nether e End novos: gera aqui a parte que os jogadores alcançam, com borda, para a Pi não gerar nada
        # Nether: 1 bloco lá = 8 aqui, então a borda é 1/8 da de cima (com folga)
        borda_nether = max(128, math.ceil(info['borda_tamanho'] / 8 / 16) * 16 + 32)
        print(f'    Nether (borda {borda_nether})…')
        info['nether'] = pregerar(r, 'the_nether', borda_nether)
        print('    End (borda 512, ilha principal)…')
        info['end'] = pregerar(r, 'the_end', 512)

    json.dump(info, open(os.path.join(saida, 'info.json'), 'w', encoding='utf-8'), indent=2, ensure_ascii=False)

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
    main(sys.argv[1], mundo_novo='--mundo-novo' in sys.argv[2:])
