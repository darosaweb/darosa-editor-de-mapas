"""Gerador: transforma um projeto do editor (.mcmapa) em arquivos de região Anvil (.mca) do Minecraft 26.3.

Cada chunk é gravado com status "minecraft:terrain": pedra, água, superfície e biomas prontos.
O Minecraft completa o resto (árvores, flores, minérios, neve, luz) — ver analise/ESTRUTURA.md.

Uso:
  python -I -X utf8 gerar.py projeto.mcmapa pasta_saida [--anel 8]

Coordenadas: o centro do desenho fica no centro do mundo (X=0, Z=0).
"""
import argparse
import base64
import gzip
import json
import math
import os
import random
import struct
import sys
import time
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nbt import Byte, Int, Long, LongArray, NbtList, dumps  # noqa: E402
from chunkfmt import pack, bits_for  # noqa: E402

DATA_VERSION = 5023          # Minecraft 26.3 (lido do mundo da Pi)
MIN_Y, MAX_Y = -64, 319
SEC_MIN, SEC_MAX = -4, 19    # 24 seções

AIR, WATER, STONE, DEEPSLATE, BEDROCK = ('minecraft:air', 'minecraft:water', 'minecraft:stone',
                                         'minecraft:deepslate', 'minecraft:bedrock')
CAVE_AIR, LAVA = 'minecraft:cave_air', 'minecraft:lava'
# chance de um chunk do desenho começar um sistema de cavernas, conforme a escolha "⛏️ Cavernas" do editor
CAVE_CHANCE = {'nenhuma': 0.0, 'poucas': 0.06, 'normal': 0.14, 'muitas': 0.28}
CAVE_MIN_Y = -59             # não escava a camada de bedrock
CAVE_TETO = 5                # blocos de rocha preservados embaixo do chão (terra)
CAVE_TETO_AGUA = 6           # idem embaixo de água (não inunda as cavernas)
LAVA_Y = -55                 # abaixo disso a caverna fica com lava, como no Minecraft normal
OCEAN_DEPTH = 14            # profundidade do oceano em volta do desenho
BLEND = 24                   # blocos para o terreno descer suavemente até o oceano fora do desenho

AQUATIC = {'minecraft:ocean', 'minecraft:warm_ocean', 'minecraft:frozen_ocean', 'minecraft:river',
           'minecraft:deep_ocean', 'minecraft:lukewarm_ocean', 'minecraft:cold_ocean'}
# mesmo critério do editor (editor/js/biomes.js): estilo de vila que combina com o bioma
VILA_POR_BIOMA = {
    'minecraft:desert': 'desert', 'minecraft:badlands': 'desert', 'minecraft:beach': 'desert',
    'minecraft:savanna': 'savanna', 'minecraft:taiga': 'taiga',
    'minecraft:snowy_plains': 'snowy', 'minecraft:snowy_taiga': 'snowy',
}
BADLANDS_BANDS = ['minecraft:terracotta', 'minecraft:orange_terracotta', 'minecraft:yellow_terracotta',
                  'minecraft:terracotta', 'minecraft:white_terracotta', 'minecraft:orange_terracotta',
                  'minecraft:red_terracotta', 'minecraft:terracotta', 'minecraft:light_gray_terracotta',
                  'minecraft:brown_terracotta', 'minecraft:orange_terracotta']


def rnd(x, y, z, salt=0):
    """Número pseudo-aleatório estável 0..1 por posição (para bedrock, transição de deepslate etc.)."""
    h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791) ^ (salt * 2654435761)
    h &= 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 1274126177) & 0xFFFFFFFF
    h ^= h >> 16
    return h / 4294967296.0


# ---------------------------------------------------------------- projeto
def load_project(path):
    raw = open(path, 'rb').read()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    p = json.loads(raw.decode('utf-8'))
    if p.get('formato') != 'minicraft-mapa':
        raise SystemExit('arquivo não é um projeto do editor de mapas')
    w, h = p['largura'], p['altura']
    heights = struct.unpack(f'<{w * h}h', base64.b64decode(p['alturas']))
    biome_idx = base64.b64decode(p['biomaGrade'])
    names = p['biomas']
    biomes = [names[i] for i in biome_idx]
    return p, w, h, heights, biomes


class World:
    """Altura e bioma de qualquer coluna do mundo, inclusive fora do desenho (oceano)."""

    def __init__(self, w, h, sea, heights, biomes):
        self.w, self.h, self.sea = w, h, sea
        self.heights, self.biomes = heights, biomes
        self.ox, self.oz = -w // 2, -h // 2     # coordenada do mundo do pixel (0,0)
        self.floor = sea - OCEAN_DEPTH

    def column(self, wx, wz):
        x, z = wx - self.ox, wz - self.oz
        if 0 <= x < self.w and 0 <= z < self.h:
            i = z * self.w + x
            return self.heights[i], self.biomes[i]
        # fora do desenho: continua a borda e desce até o fundo do oceano
        cx, cz = min(max(x, 0), self.w - 1), min(max(z, 0), self.h - 1)
        d = math.hypot(x - cx, z - cz)
        edge_h = self.heights[cz * self.w + cx]
        t = min(1.0, d / BLEND)
        t = t * t * (3 - 2 * t)
        hh = round(edge_h + (self.floor - edge_h) * t)
        return hh, 'minecraft:ocean'


# ---------------------------------------------------------------- superfície por bioma
def surface_layers(biome, top, sea, slope, wx, wz):
    """Blocos do topo da coluna, de cima para baixo: lista de (y, bloco)."""
    under = top < sea - 1          # coberto de água
    if under:
        depth = sea - 1 - top
        if biome in ('minecraft:river',) or depth <= 5:
            mat = ['minecraft:sand'] * 3 + ['minecraft:sandstone']
        elif biome == 'minecraft:swamp':
            mat = ['minecraft:dirt'] * 3
        else:
            mat = (['minecraft:gravel'] if rnd(wx, 0, wz, 7) < 0.6 else ['minecraft:sand']) * 3
            if rnd(wx, 1, wz, 8) < 0.04:
                mat[0] = 'minecraft:clay'
        return [(top - i, b) for i, b in enumerate(mat)]

    if biome == 'minecraft:desert':
        mat = ['minecraft:sand'] * 4 + ['minecraft:sandstone'] * 3
    elif biome == 'minecraft:beach':
        mat = ['minecraft:sand'] * 4 + ['minecraft:sandstone']
    elif biome == 'minecraft:badlands':
        mat = ['minecraft:red_sand'] + [BADLANDS_BANDS[(top - 1 - i) % len(BADLANDS_BANDS)] for i in range(12)]
    elif biome == 'minecraft:mushroom_fields':
        mat = ['minecraft:mycelium'] + ['minecraft:dirt'] * 3
    elif biome == 'minecraft:stony_peaks':
        mat = ['minecraft:stone'] if rnd(wx, top, wz, 3) < 0.8 else ['minecraft:calcite']
    elif biome in AQUATIC:   # oceano/rio pintado mas acima da água: praia
        mat = ['minecraft:sand'] * 3 + ['minecraft:sandstone']
    else:
        mat = ['minecraft:grass_block'] + ['minecraft:dirt'] * 3

    # encostas íngremes viram pedra (como no Minecraft normal)
    if slope >= 4 and biome not in ('minecraft:desert', 'minecraft:badlands', 'minecraft:beach'):
        mat = ['minecraft:stone'] if slope >= 7 else ['minecraft:gravel' if rnd(wx, 2, wz, 4) < 0.3 else 'minecraft:stone']
    # topos muito altos com neve
    if top >= 175 and biome not in ('minecraft:desert', 'minecraft:badlands', 'minecraft:savanna', 'minecraft:jungle'):
        mat = ['minecraft:snow_block'] * 2
    return [(top - i, b) for i, b in enumerate(mat)]


# ---------------------------------------------------------------- chunk
def _worm(rng, spheres, x, y, z, comp, base_r):
    """Um túnel sinuoso a partir de (x, y, z)."""
    yaw, pitch = rng.uniform(0, 2 * math.pi), rng.uniform(-0.35, 0.35)
    dyaw = 0.0
    for i in range(comp):
        x += math.cos(yaw) * math.cos(pitch)
        z += math.sin(yaw) * math.cos(pitch)
        y += math.sin(pitch)
        dyaw = dyaw * 0.75 + rng.uniform(-1, 1) * 0.18
        yaw += dyaw
        pitch = pitch * 0.9 + rng.uniform(-1, 1) * 0.09
        if y < CAVE_MIN_Y + 2:
            pitch = abs(pitch)
        r = base_r * (0.75 + 0.5 * math.sin(math.pi * i / comp))
        if i % max(1, int(r / 1.5)) == 0:
            spheres.append((x, y, z, r, 1.0, False))


def plan_caves(world, cx0, cz0, cx1, cz1, seed, chance=0.14, entradas=()):
    """Planeja as cavernas do desenho: túneis sinuosos, algumas salas e as entradas marcadas no editor.
    Esfera = (x, y, z, raio, achatamento, aberta); "aberta" pode furar o chão (só nas bocas de caverna).
    Devolve {(cx, cz): [esferas que tocam o chunk]} e o total de esferas."""
    spheres = []
    for cz in range(cz0, cz1 + 1):
        for cx in range(cx0, cx1 + 1):
            # semente estável por chunk (o mesmo mapa gera sempre as mesmas cavernas)
            rng = random.Random(((seed * 73856093) ^ (cx * 19349663) ^ (cz * 83492791) ^ 0x5EED) & 0xFFFFFFFF)
            if rng.random() >= chance:
                continue
            x, z = cx * 16 + rng.random() * 16, cz * 16 + rng.random() * 16
            top, _ = world.column(int(x), int(z))
            y_max = min(48, top - 12)
            if y_max < -48:
                continue
            y = rng.uniform(-50, y_max)
            if rng.random() < 0.25:   # sala grande no começo
                spheres.append((x, y, z, rng.uniform(5, 9), 0.55, False))
            for _ in range(rng.randint(1, 3)):
                _worm(rng, spheres, x, y, z, rng.randint(50, 140), rng.uniform(1.6, 3.2))

    # bocas de caverna: rampa larga que começa no chão e desce até os túneis
    for ex, ez in entradas:
        rng = random.Random(((seed * 83492791) ^ (ex * 73856093) ^ (ez * 19349663) ^ 0xCAFE) & 0xFFFFFFFF)
        top, _ = world.column(ex, ez)
        x, y, z = ex + 0.5, top + 0.5, ez + 0.5
        spheres.append((x, y, z, 3.6, 0.8, True))              # a boca, bem aberta
        yaw, pitch = rng.uniform(0, 2 * math.pi), -0.7
        fundo = max(-40, top - rng.randint(35, 60))
        for i in range(200):
            x += math.cos(yaw) * math.cos(pitch)
            z += math.sin(yaw) * math.cos(pitch)
            y += math.sin(pitch)
            yaw += rng.uniform(-0.12, 0.12)
            pitch = max(-0.9, min(-0.3, pitch + rng.uniform(-0.08, 0.08)))   # sempre descendo
            spheres.append((x, y, z, 3.0 if i < 8 else 2.4, 1.0, i < 18))
            if y <= fundo:
                break
        spheres.append((x, y, z, rng.uniform(4.5, 6.5), 0.6, False))   # sala no fim da rampa
        for _ in range(2):                                                  # túneis que seguem dali
            _worm(rng, spheres, x, y, z, rng.randint(60, 120), rng.uniform(1.8, 3.0))

    by_chunk = {}
    for s in spheres:
        x, _, z, r = s[:4]
        for ccz in range(math.floor((z - r) / 16), math.floor((z + r) / 16) + 1):
            for ccx in range(math.floor((x - r) / 16), math.floor((x + r) / 16) + 1):
                by_chunk.setdefault((ccx, ccz), []).append(s)
    return by_chunk, len(spheres)


def build_chunk(world, cx, cz, caves=None):
    sea = world.sea
    # alturas com 1 bloco de margem (para medir inclinação)
    hgt = {}
    bio = {}
    for dz in range(-1, 17):
        for dx in range(-1, 17):
            hh, bb = world.column(cx * 16 + dx, cz * 16 + dz)
            hgt[(dx, dz)] = max(MIN_Y + 5, min(MAX_Y - 1, int(hh)))
            bio[(dx, dz)] = bb

    cols = []   # índice z*16+x
    for z in range(16):
        for x in range(16):
            top = hgt[(x, z)]
            slope = max(abs(top - hgt[(x + 1, z)]), abs(top - hgt[(x - 1, z)]),
                        abs(top - hgt[(x, z + 1)]), abs(top - hgt[(x, z - 1)]))
            wx, wz = cx * 16 + x, cz * 16 + z
            surf = dict(surface_layers(bio[(x, z)], top, sea, slope, wx, wz))
            cols.append((top, surf, wx, wz))

    tops = [c[0] for c in cols]
    max_top, min_top = max(tops), min(tops)
    min_surf = min(min(c[1]) if c[1] else c[0] for c in cols)

    # cavernas: blocos escavados por esferas que passam por este chunk
    carved = set()
    carved_secs = set()
    bx0, bz0 = cx * 16, cz * 16
    for (sx, sy, sz, r, vs, aberta) in caves or ():
        ry = r * vs
        xa, xb = max(0, math.floor(sx - r) - bx0), min(15, math.ceil(sx + r) - bx0)
        za, zb = max(0, math.floor(sz - r) - bz0), min(15, math.ceil(sz + r) - bz0)
        if xa > xb or za > zb:
            continue
        for y in range(max(CAVE_MIN_Y, math.floor(sy - ry)), math.ceil(sy + ry) + 1):
            dy = (y + 0.5 - sy) / ry
            dy2 = dy * dy
            if dy2 > 1:
                continue
            for z in range(za, zb + 1):
                dz = (bz0 + z + 0.5 - sz) / r
                rest = 1 - dy2 - dz * dz
                if rest < 0:
                    continue
                for x in range(xa, xb + 1):
                    dx = (bx0 + x + 0.5 - sx) / r
                    if dx * dx <= rest:
                        ci = z * 16 + x
                        top = tops[ci]
                        if top < sea - 1:
                            limite = top - CAVE_TETO_AGUA          # embaixo d'água: nunca fura
                        else:
                            limite = top if aberta else top - CAVE_TETO
                        if y <= limite:
                            carved.add((y - MIN_Y) * 256 + ci)
                            carved_secs.add(y >> 4)

    # onde a boca da caverna furou o chão, o topo da coluna desceu (para os heightmaps)
    new_tops = list(tops)
    if carved:
        for ci in range(256):
            t = tops[ci]
            if t >= sea - 1 and (t - MIN_Y) * 256 + ci in carved:
                y = t
                while y > MIN_Y and (y - MIN_Y) * 256 + ci in carved:
                    y -= 1
                new_tops[ci] = y

    def block(c, y, ci=None):
        if carved and ci is not None and (y - MIN_Y) * 256 + ci in carved:
            return LAVA if y <= LAVA_Y else CAVE_AIR
        top, surf, wx, wz = c
        if y > top:
            return WATER if y < sea else AIR
        b = surf.get(y)
        if b:
            return b
        if y <= MIN_Y + 4:
            if y == MIN_Y or rnd(wx, y, wz, 1) < (MIN_Y + 5 - y) / 5:
                return BEDROCK
            return DEEPSLATE
        if y < 0:
            return DEEPSLATE
        if y < 8:
            return DEEPSLATE if rnd(wx, y, wz, 2) < (8 - y) / 8 else STONE
        return STONE

    sections = []
    for sy in range(SEC_MIN, SEC_MAX + 1):
        base = sy * 16
        top_y = base + 15
        if sy in carved_secs:
            uniform = None
        elif base > max_top and base >= sea:
            uniform = AIR
        elif top_y < min_surf and base >= 8:
            uniform = STONE
        elif top_y < min_surf and top_y < 0 and base > MIN_Y + 4:
            uniform = DEEPSLATE
        else:
            uniform = None
        if uniform:
            bs = {'palette': NbtList([uniform], 8)}
        else:
            palette = {}
            idx = []
            for y in range(base, base + 16):
                for ci, c in enumerate(cols):
                    name = block(c, y, ci)
                    i = palette.get(name)
                    if i is None:
                        i = palette[name] = len(palette)
                    idx.append(i)
            names = list(palette)
            if len(names) == 1:
                bs = {'palette': NbtList(names, 8)}
            else:
                bs = {'palette': NbtList(names, 8), 'data': LongArray(pack(idx, bits_for(len(names), 4)))}

        # biomas: células 4x4x4, mesmo bioma em toda a altura
        bpal = {}
        bidx = []
        for _y in range(4):
            for qz in range(4):
                for qx in range(4):
                    name = bio[(qx * 4 + 2, qz * 4 + 2)]
                    i = bpal.get(name)
                    if i is None:
                        i = bpal[name] = len(bpal)
                    bidx.append(i)
        bnames = list(bpal)
        biomes = {'palette': NbtList(bnames, 8)}
        if len(bnames) > 1:
            biomes['data'] = LongArray(pack(bidx, bits_for(len(bnames), 1)))
        sections.append({'Y': Byte(sy), 'biomes': biomes, 'block_states': bs})

    # heightmaps (valor = y do bloco mais alto + 1 - MIN_Y)
    # coluna com água: a água conta para WORLD_SURFACE; coluna de terra: o topo real (já com a boca de caverna)
    surface = [(max(t, sea - 1) if t < sea - 1 else nt) + 1 - MIN_Y for t, nt in zip(tops, new_tops)]
    floor = [nt + 1 - MIN_Y for nt in new_tops]                # só sólidos
    hm = lambda vals: LongArray(pack(vals, 9))  # noqa: E731
    heightmaps = {
        'MOTION_BLOCKING': hm(surface), 'MOTION_BLOCKING_NO_LEAVES': hm(surface),
        'OCEAN_FLOOR': hm(floor), 'OCEAN_FLOOR_WG': hm(floor),
        'WORLD_SURFACE': hm(surface), 'WORLD_SURFACE_WG': hm(surface),
    }
    empty = lambda: NbtList([], 0)  # noqa: E731
    return {
        'DataVersion': Int(DATA_VERSION),
        'xPos': Int(cx), 'yPos': Int(SEC_MIN), 'zPos': Int(cz),
        'Status': 'minecraft:terrain',
        'InhabitedTime': Long(0), 'LastUpdate': Long(0),
        'sections': NbtList(sections, 10),
        'Heightmaps': heightmaps,
        'structures': {'References': {}, 'starts': {}},
        'PostProcessing': NbtList([empty() for _ in range(SEC_MAX - SEC_MIN + 1)], 9),
        'block_ticks': empty(), 'fluid_ticks': empty(),
        'block_entities': empty(), 'entities': empty(),
    }


# ---------------------------------------------------------------- região
def write_region(path, chunks):
    """chunks: {(lx, lz): bytes NBT}."""
    locations = bytearray(4096)
    stamps = bytearray(4096)
    body = bytearray()
    sector = 2
    now = int(time.time())
    for (lx, lz), raw in sorted(chunks.items()):
        comp = zlib.compress(raw, 6)
        payload = struct.pack('>IB', len(comp) + 1, 2) + comp
        n = (len(payload) + 4095) // 4096
        if n > 255:
            raise ValueError('chunk grande demais')
        payload += b'\x00' * (n * 4096 - len(payload))
        off = 4 * (lx + lz * 32)
        struct.pack_into('>I', locations, off, (sector << 8) | n)
        struct.pack_into('>I', stamps, off, now)
        body += payload
        sector += n
    with open(path, 'wb') as f:
        f.write(locations + stamps + body)


def find_spawn(world):
    """Coluna de terra firme mais perto do centro do desenho."""
    for r in range(0, max(world.w, world.h) // 2, 2):
        for dx in range(-r, r + 1, 2):
            for dz in (-r, r) if abs(dx) != r else range(-r, r + 1, 2):
                h, b = world.column(dx, dz)
                if h >= world.sea and b not in AQUATIC:
                    return dx, h + 1, dz
    return 0, world.sea + 1, 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('projeto')
    ap.add_argument('saida')
    ap.add_argument('--anel', type=int, default=8, help='chunks de oceano em volta do desenho (padrão 8)')
    ap.add_argument('--sem-cavernas', action='store_true', help='não escava cavernas')
    a = ap.parse_args()

    p, w, h, heights, biomes = load_project(a.projeto)
    if w % 16 or h % 16:
        raise SystemExit('largura e altura do mapa precisam ser múltiplos de 16')
    sea = p['nivelMar']
    world = World(w, h, sea, heights, biomes)
    c0x, c0z = world.ox // 16 - a.anel, world.oz // 16 - a.anel
    c1x, c1z = (world.ox + w) // 16 + a.anel - 1, (world.oz + h) // 16 + a.anel - 1

    os.makedirs(os.path.join(a.saida, 'region'), exist_ok=True)
    regions = {}
    t0 = time.time()
    caves, n_esferas = {}, 0
    marcadores = p.get('marcadores') or {}
    qtd_cavernas = 'nenhuma' if a.sem_cavernas else (p.get('cavernas') or 'normal')
    entradas = []
    for e in marcadores.get('entradas') or []:
        wx, wz = e['x'] + world.ox, e['z'] + world.oz
        hh, bb = world.column(wx, wz)
        if hh < sea or bb in AQUATIC:
            print(f'  aviso: a entrada de caverna em X {wx} Z {wz} ficou na água; ignorada')
            continue
        entradas.append((wx, wz))
    if qtd_cavernas != 'nenhuma' or entradas:
        caves, n_esferas = plan_caves(world, world.ox // 16, world.oz // 16,
                                      (world.ox + w) // 16 - 1, (world.oz + h) // 16 - 1, int(p.get('semente') or 0),
                                      CAVE_CHANCE.get(qtd_cavernas, CAVE_CHANCE['normal']), entradas)
        print(f'  cavernas: {qtd_cavernas}, {len(entradas)} entrada(s) marcada(s), {n_esferas} trechos')
    total = (c1x - c0x + 1) * (c1z - c0z + 1)
    done = 0
    for cz in range(c0z, c1z + 1):
        for cx in range(c0x, c1x + 1):
            raw = dumps(build_chunk(world, cx, cz, caves.get((cx, cz))))
            regions.setdefault((cx >> 5, cz >> 5), {})[(cx & 31, cz & 31)] = raw
            done += 1
        print(f'\r  chunks: {done}/{total}', end='', flush=True)
    print()
    for (rx, rz), chunks in regions.items():
        write_region(os.path.join(a.saida, 'region', f'r.{rx}.{rz}.mca'), chunks)

    spawn, spawn_origem = find_spawn(world), 'automático (terra firme mais perto do centro)'
    nascer = marcadores.get('nascer')
    if nascer:
        wx, wz = nascer['x'] + world.ox, nascer['z'] + world.oz
        hh, bb = world.column(wx, wz)
        if hh >= sea and bb not in AQUATIC:
            spawn, spawn_origem = (wx, hh + 1, wz), 'marcado no editor 🏠'
        else:
            print('  aviso: o ponto 🏠 está na água; usando o automático')
    vilas = []
    for v in marcadores.get('vilas') or []:
        wx, wz = v['x'] + world.ox, v['z'] + world.oz
        hh, bb = world.column(wx, wz)
        if hh < sea or bb in AQUATIC:
            print(f'  aviso: a vila em X {wx} Z {wz} ficou na água; ignorada')
            continue
        vilas.append({'x': wx, 'y': hh + 1, 'z': wz, 'bioma': bb,
                      'estrutura': f'minecraft:village_{VILA_POR_BIOMA.get(bb, "plains")}'})
    info = {
        'projeto': p.get('nome'), 'largura': w, 'altura': h, 'nivelMar': sea,
        'desenho_x': [world.ox, world.ox + w - 1], 'desenho_z': [world.oz, world.oz + h - 1],
        'chunks_x': [c0x, c1x], 'chunks_z': [c0z, c1z],
        # borda do mundo: o desenho + 16 blocos de mar, centrada no 0,0
        'borda_centro': [0, 0], 'borda_tamanho': max(w, h) + 32,
        'spawn': spawn,
        'spawn_origem': spawn_origem,
        'vilas': vilas,
        'cavernas': qtd_cavernas,
        'entradas_caverna': [{'x': x, 'y': world.column(x, z)[0], 'z': z} for x, z in entradas],
        'regioes': sorted(f'r.{rx}.{rz}.mca' for rx, rz in regions),
    }
    json.dump(info, open(os.path.join(a.saida, 'info.json'), 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    print(f'{total} chunks em {len(regions)} regiões, {time.time() - t0:.1f}s.')
    print(f'Spawn: {spawn} ({spawn_origem}). Vilas marcadas: {len(vilas)}'
          + ''.join(f'\n  - {v["estrutura"]} em X {v["x"]} Z {v["z"]}' for v in vilas))


if __name__ == '__main__':
    main()
