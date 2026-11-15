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
from chunkfmt import section_blocks  # noqa: E402
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


# ---------------------------------------------------------------- vilas
VEGETACAO = ['#minecraft:leaves', '#minecraft:logs', '#minecraft:flowers', '#minecraft:saplings',
             'minecraft:short_grass', 'minecraft:tall_grass', 'minecraft:fern', 'minecraft:large_fern',
             'minecraft:bush', 'minecraft:firefly_bush', 'minecraft:dead_bush', 'minecraft:sweet_berry_bush',
             'minecraft:brown_mushroom_block', 'minecraft:red_mushroom_block', 'minecraft:mushroom_stem',
             'minecraft:vine', 'minecraft:bamboo', 'minecraft:cactus', 'minecraft:leaf_litter',
             'minecraft:moss_carpet', 'minecraft:pale_moss_carpet', 'minecraft:pale_hanging_moss',
             'minecraft:mangrove_roots', 'minecraft:bee_nest', 'minecraft:snow']
VILA_LIMPAR = 96          # raio (blocos) da área limpa em volta da vila (vilas chegam a ~90 blocos do centro)
VILA_ALTURA = 44          # do chão até onde limpar


def limpar_area_vila(r, v):
    """Tira árvores e plantas em volta do marcador (em caixas de 32x32x32, o limite do comando /fill)."""
    y0 = v['y'] - 3
    y1 = v['y'] + VILA_ALTURA
    n = 0
    for bx in range(v['x'] - VILA_LIMPAR, v['x'] + VILA_LIMPAR, 32):
        for bz in range(v['z'] - VILA_LIMPAR, v['z'] + VILA_LIMPAR, 32):
            for by in range(y0, y1 + 1, 32):
                caixa = f'{bx} {by} {bz} {bx + 31} {min(by + 31, y1)} {bz + 31}'
                for alvo in VEGETACAO:
                    resp = r.cmd(f'fill {caixa} air replace {alvo}')
                    if resp.startswith('Successfully'):
                        n += int(''.join(ch for ch in resp.split('filled')[-1] if ch.isdigit()) or 0)
    return n


class LeitorBlocos:
    """Lê blocos do mundo salvo (para conferir as vilas depois de construídas)."""

    def __init__(self, pasta):
        self.pasta, self.cache = pasta, {}

    def chunk(self, cx, cz):
        k = (cx, cz)
        if k not in self.cache:
            secoes = {}
            path = os.path.join(self.pasta, 'region', f'r.{cx >> 5}.{cz >> 5}.mca')
            if os.path.exists(path):
                ch = Region(path).chunk(cx & 31, cz & 31)
                for s in (ch or {}).get('sections', []):
                    b = section_blocks(s)
                    if b:
                        secoes[s['Y']] = b
            self.cache[k] = secoes
        return self.cache[k]

    def bloco(self, x, y, z):
        b = self.chunk(x >> 4, z >> 4).get(y >> 4)
        return b[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] if b else 'minecraft:air'


AR = {'minecraft:air', 'minecraft:cave_air'}
# "enterrado" = terreno de verdade por cima do caminho (não conta lanterna, flor, base de casa…)
TERRENO = ('stone', 'dirt', 'grass_block', 'sand', 'gravel', 'deepslate', 'granite', 'diorite', 'andesite',
           'tuff', 'mud', 'podzol', 'mycelium', 'coarse_dirt', 'snow_block', 'terracotta', 'calcite', '_ore')


def conferir_vila(leitor, v, raio=90):
    """Confere as ruas da vila: quantas ficaram sobre a água, sobre árvores, no ar ou enterradas no terreno."""
    deserto = 'desert' in v['estrutura']
    rua = 'minecraft:smooth_sandstone' if deserto else 'minecraft:dirt_path'
    # no deserto as casas também são de arenito liso: só conta o que está na altura do chão (as ruas)
    faixa = range(v['y'] - 4, v['y'] + 2) if deserto else range(v['y'] - 25, v['y'] + 30)
    c = {'caminhos': 0, 'sobre_agua': 0, 'sobre_arvore': 0, 'no_ar': 0, 'enterrados': 0, 'sinos': 0}
    for x in range(v['x'] - raio, v['x'] + raio + 1):
        for z in range(v['z'] - raio, v['z'] + raio + 1):
            for y in range(v['y'] - 25, v['y'] + 30):
                b = leitor.bloco(x, y, z)
                if b == 'minecraft:bell':
                    c['sinos'] += 1
                if b != rua or y not in faixa:
                    continue
                baixo, cima = leitor.bloco(x, y - 1, z), leitor.bloco(x, y + 1, z)
                if deserto and cima not in AR:
                    continue          # parede/chão de casa, não é rua
                c['caminhos'] += 1
                if baixo == 'minecraft:water':
                    c['sobre_agua'] += 1
                elif 'leaves' in baixo or baixo.endswith('_log'):
                    c['sobre_arvore'] += 1
                elif baixo in AR:
                    c['no_ar'] += 1
                elif any(t in cima for t in TERRENO):
                    # só conta se for uma camada fina de terreno (1 a 3 blocos): defeito que aparece no jogo.
                    # Camada grossa = parte de dentro de construção (base do poço etc.), ninguém vê.
                    k = 1
                    while k <= 4 and any(t in leitor.bloco(x, y + k, z) for t in TERRENO):
                        k += 1
                    if k <= 4:
                        c['enterrados'] += 1
    ruins = c['sobre_arvore'] + c['no_ar'] + c['enterrados']
    n = max(1, c['caminhos'])
    c['ok'] = c['caminhos'] > 0 and c['sinos'] > 0 and ruins <= 0.08 * n and c['sobre_agua'] <= 0.1 * n
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
    r.cmd(pre + 'worldborder center 0.0 0.0')
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
    print('   ', r.cmd(f'worldborder center {info["borda_centro"][0]}.0 {info["borda_centro"][1]}.0'))
    print('   ', r.cmd(f'worldborder set {info["borda_tamanho"]}'))

    print('4/5 completando os chunks (árvores, minérios, luz)…')
    (x0, x1), (z0, z1) = info['chunks_x'], info['chunks_z']
    forcar_carregar(r, 'overworld', x0, x1, z0, z1)
    esperar_prontos(r, info, OVERWORLD, 'mundo de cima')
    # vilas marcadas no editor: o próprio Minecraft constrói (casas, caminhos, aldeões)
    vilas = info.get('vilas') or []
    resultado_vilas = []
    for v in vilas:
        limpos = limpar_area_vila(r, v)          # primeiro tira as árvores, senão a vila se apoia nas copas
        resp = r.cmd(f'place structure {v["estrutura"]} {v["x"]} {v["y"]} {v["z"]}')
        colocada = 'Generated' in resp or 'gerad' in resp.lower()
        resultado_vilas.append({**v, 'colocada': colocada, 'blocos_limpos': limpos, 'resposta': resp.strip()})
    if vilas:
        time.sleep(5)          # deixa o servidor terminar de colocar as peças das vilas
        r.cmd('save-all flush')
        time.sleep(2)
        leitor = LeitorBlocos(OVERWORLD)
        for v in resultado_vilas:
            chk = conferir_vila(leitor, v) if v['colocada'] else {'ok': False}
            v['checagem'] = chk
            v['ok'] = v['colocada'] and chk['ok']
            detalhe = (f'{chk["caminhos"]} trechos de rua: {chk["sobre_agua"]} sobre a água, '
                       f'{chk["sobre_arvore"]} sobre árvore, {chk["no_ar"]} no ar, {chk["enterrados"]} enterrados, '
                       f'{chk["sinos"]} sino(s)') if v['colocada'] else v['resposta']
            print(f'    vila {v["estrutura"]} em X {v["x"]} Z {v["z"]}: {"✓" if v["ok"] else "⚠"} {detalhe}')
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
