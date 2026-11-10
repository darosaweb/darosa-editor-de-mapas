"""Analisa chunks reais copiados da Pi (somente leitura) e confere que entendemos o formato.

Uso: python -I analisar.py ../analise/pi-copia
"""
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # funciona também com python -I

from anvil import Region
from chunkfmt import section_blocks, section_biomes, heightmap, unpack, pack, bits_for
from nbt import loads, dumps, describe

MIN_Y = -64
NAO_CONTA = {'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'}


def column_tops(chunk, solid_only=False):
    """Y+1 do bloco mais alto não-ar de cada coluna (índice z*16+x)."""
    tops = [MIN_Y] * 256
    secs = sorted(chunk['sections'], key=lambda s: s['Y'])
    for s in secs:
        blocks = section_blocks(s)
        if not blocks:
            continue
        base = s['Y'] * 16
        for i, name in enumerate(blocks):
            if name in NAO_CONTA:
                continue
            if solid_only and name in ('minecraft:water', 'minecraft:lava'):
                continue
            y = base + (i >> 8) + 1
            col = i & 255
            if y > tops[col]:
                tops[col] = y
    return tops


def check_chunk(label, ch):
    print(f'\n## {label}: Status={ch["Status"]} DataVersion={ch["DataVersion"]} pos=({ch["xPos"]},{ch["zPos"]}) yPos={ch["yPos"]}')
    secs = ch['sections']
    print(f'seções: {len(secs)} (Y de {min(s["Y"] for s in secs)} a {max(s["Y"] for s in secs)})')
    keys = Counter(k for s in secs for k in s)
    print('chaves nas seções:', dict(keys))
    # blocos e biomas
    blocks = Counter()
    biomes = Counter()
    for s in secs:
        b = section_blocks(s)
        if b:
            blocks.update(b)
        bi = section_biomes(s)
        if bi:
            biomes.update(bi)
    print('biomas (células 4x4x4):', dict(biomes.most_common(6)))
    print('blocos mais comuns:', ', '.join(f'{k.split(":")[1]}={v}' for k, v in blocks.most_common(14)))
    # exemplo de paleta com propriedades
    for s in secs:
        pal = s.get('block_states', {}).get('palette', [])
        props = [p for p in pal if isinstance(p, dict) and ('properties' in p or 'Properties' in p)]
        if props:
            print('exemplo de bloco com propriedades:', props[0])
            break
    # mapas de altura conferidos com os blocos
    hm = ch.get('Heightmaps', {})
    tops = column_tops(ch)
    for name, longs in hm.items():
        vals = heightmap(longs, MIN_Y)
        same = sum(1 for a, b in zip(vals, tops) if a == b)
        print(f'heightmap {name:26s} [{len(longs)} longs] confere com "bloco mais alto" em {same}/256 colunas; amostra {vals[:4]}')
    # luz
    luz = [k for k in keys if 'Light' in k or 'light' in k]
    print('dados de luz nas seções:', luz or 'nenhum', '| isLightOn =', ch.get('isLightOn'))


def roundtrip_tests(region):
    lx, lz = next(region.chunks())
    ctype, raw = region.raw_chunk(lx, lz)
    name, d = loads(raw)
    ok_nbt = dumps(d, name) == raw
    s = next(x for x in d['sections'] if 'data' in x.get('block_states', {}))
    bs = s['block_states']
    bits = bits_for(len(bs['palette']), 4)
    ok_pack = pack(unpack(bs['data'], bits, 4096), bits) == list(bs['data'])
    print(f'\nTeste ler→gravar NBT idêntico byte a byte: {ok_nbt}; compactação de blocos idêntica: {ok_pack}')


def main(folder):
    r0 = Region(f'{folder}/r.0.0.mca')
    r3 = Region(f'{folder}/r.0.3.mca')
    roundtrip_tests(r0)
    wanted = {'minecraft:full': None, 'minecraft:terrain': None, 'minecraft:initialize_light': None}
    for lx, lz in r0.chunks():
        ch = r0.chunk(lx, lz)
        st = ch['Status']
        if st in wanted and wanted[st] is None and ch['DataVersion'] == 5023:
            wanted[st] = ch
    for st, ch in wanted.items():
        if ch:
            check_chunk(st, ch)
    lx, lz = next(r3.chunks())
    check_chunk('borda (structure_starts)', r3.chunk(lx, lz))

    print('\n## Estrutura completa de um chunk "full" (DataVersion 5023)')
    print('\n'.join(describe(wanted['minecraft:full'], max_items=5, max_depth=4)))
    sec = next(s for s in wanted['minecraft:full']['sections'] if s['Y'] == 4)
    print('\n## Uma seção (Y=4) do chunk "full"')
    print('\n'.join(describe(sec, max_items=8)))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '../analise/pi-copia')
