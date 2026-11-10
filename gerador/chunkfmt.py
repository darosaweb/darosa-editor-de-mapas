"""Compactação dos dados dentro de um chunk (formato 1.18+ / 26.x).

- block_states: 4096 blocos por seção (16x16x16), índice = y*256 + z*16 + x,
  bits por entrada = max(4, ceil(log2(tamanho da paleta))); entradas não atravessam longs.
- biomes: 64 células de 4x4x4 por seção, índice = y*16 + z*4 + x,
  bits = ceil(log2(tamanho da paleta)) (paleta de 1 item = sem 'data').
- Heightmaps: 256 colunas, índice = z*16 + x, 9 bits cada (altura 384 do overworld),
  valor = (y do bloco mais alto que conta + 1) - min_y.
"""
import math


def _to_signed(v):
    return v - (1 << 64) if v >= (1 << 63) else v


def _to_unsigned(v):
    return v + (1 << 64) if v < 0 else v


def bits_for(n, minimum):
    return max(minimum, math.ceil(math.log2(n))) if n > 1 else 0


def unpack(longs, bits, count):
    if bits == 0:
        return [0] * count
    per = 64 // bits
    mask = (1 << bits) - 1
    out = []
    for lv in longs:
        u = _to_unsigned(lv)
        for k in range(per):
            out.append((u >> (k * bits)) & mask)
            if len(out) == count:
                return out
    return out


def pack(values, bits):
    if bits == 0:
        return []
    per = 64 // bits
    out = []
    for i in range(0, len(values), per):
        u = 0
        for k, v in enumerate(values[i:i + per]):
            u |= v << (k * bits)
        out.append(_to_signed(u))
    return out


def block_name(p):
    """Nome do bloco numa entrada de paleta. Formatos vistos no 26.3:
    'minecraft:stone'                              (só texto, quando a lista é toda de textos)
    {'': 'minecraft:stone'}                        (texto "embrulhado", quando a lista mistura tipos)
    {'id': 'minecraft:water', 'properties': {...}} (bloco com propriedades)
    {'Name': ..., 'Properties': ...}               (formato antigo, chunks de versões anteriores)
    """
    if isinstance(p, str):
        return p
    return p.get('id') or p.get('') or p.get('Name')


def section_blocks(sec):
    """Lista de 4096 nomes de bloco da seção (ignora propriedades)."""
    bs = sec.get('block_states')
    if not bs:
        return None
    pal = bs['palette']
    names = [block_name(p) for p in pal]
    if len(pal) == 1:
        return [names[0]] * 4096
    idx = unpack(bs['data'], bits_for(len(pal), 4), 4096)
    return [names[i] for i in idx]


def section_biomes(sec):
    b = sec.get('biomes')
    if not b:
        return None
    pal = list(b['palette'])
    if len(pal) == 1:
        return [pal[0]] * 64
    idx = unpack(b['data'], bits_for(len(pal), 1), 64)
    return [pal[i] for i in idx]


def heightmap(longs, min_y=-64):
    """Devolve 256 valores de Y (do bloco mais alto + 1) a partir do LongArray."""
    return [v + min_y for v in unpack(longs, 9, 256)]
