# Etapa 2 — Como o Minecraft 26.3 guarda o mundo

Análise feita em 10/11/2026 sobre **cópias** de arquivos da Pi (nada no servidor foi alterado):
`r.0.0.mca` (centro do mundo), `r.0.3.mca` e `r.1.3.mca` (bordas), `level.dat`, e o `paper.jar` + `cache/mojang_26.3.jar`
(o programa do servidor, copiado para servir ao teste local da etapa 3 sem baixar nada da internet).

Saída completa da análise: [relatorio-chunks.txt](relatorio-chunks.txt). Ferramentas: [../gerador/](../gerador/).

---

## Em linguagem simples

- O mundo é dividido em **chunks**: colunas de 16 × 16 blocos, do fundo (Y −64) ao céu (Y 320).
- Cada arquivo `.mca` ("região") guarda 32 × 32 chunks = 512 × 512 blocos. Um mapa de 1024 × 1024 cabe em 4 regiões.
- Cada chunk tem um **status**: até onde a geração chegou. O Minecraft 26.3 gera nesta ordem:

  | # | Status | O que acontece |
  |---|---|---|
  | 1 | `structure_starts` | decide onde nascem vilas, templos etc. |
  | 2 | `structure_references` | avisa os vizinhos sobre essas estruturas |
  | 3 | `biomes` | decide os biomas |
  | 4 | **`terrain`** | relevo de pedra + água + **superfície** (grama, areia) + **cavernas**, tudo junto |
  | 5 | **`features`** | **árvores, flores, minérios, lagos, neve e gelo** conforme o bioma |
  | 6 | `initialize_light` / `light` | iluminação |
  | 7 | `spawn` | animais iniciais |
  | 8 | `full` | pronto para jogar |

### O que isso muda no plano

A ideia original era entregar só "pedra + água + biomas" e deixar o Minecraft fazer superfície e cavernas.
**No 26.x isso não existe mais**: a Mojang juntou as antigas etapas *noise*, *surface* e *carvers* numa só (`terrain`)
— encontrei no programa a rotina que converte mundos antigos (`MergeTerrainChunkStatusFix`).

**Novo plano do gerador:** gravar cada chunk com status **`terrain`**, já com:
- pedra / deepslate / bedrock embaixo, água até o nível do mar;
- a **superfície** feita por nós conforme o bioma (grama, areia, micélio, terracota…);
- os **biomas pintados**.

O Minecraft (no **PC**, nunca na Pi) completa a partir daí: **árvores, flores, minérios, lagos, neve/gelo, luz e animais**,
exatamente do jeito de cada bioma.

| Coisa | Quem faz | Observação |
|---|---|---|
| Relevo, água, biomas | nós (do desenho) | |
| Grama / areia / neve no chão | nós + Minecraft | a neve e o gelo o Minecraft põe sozinho nos biomas frios |
| Árvores, flores, minérios, lagos | Minecraft | confirmado: features rodam depois de `terrain` |
| Cavernas | **nós** (etapa 4) | eram parte de `terrain`; sem isso o mapa fica sem cavernas (minérios aparecem mesmo assim) |
| Vilas e estruturas | **comando `/place structure`** no PC (etapa 4) | o status `terrain` pula a fase de estruturas |
| Luz | Minecraft | chunks `terrain` não têm luz gravada; o Paper calcula |

---

## Detalhes técnicos (para o gerador)

### `level.dat`
- `DataVersion = 5023`, `Version.Name = "26.3"`, Paper `26.3-227`.
- A semente e as opções do gerador **não** ficam mais no `level.dat` no 26.x (estão em `world/data/`); `server.properties` da Pi: `level-type=minecraft:normal`, `generate-structures=true`.

### Arquivo de região (`.mca`)
- Cabeçalho: 1024 posições (4 bytes: setor de 4 KiB << 8 | nº de setores) + 1024 carimbos de tempo.
- Cada chunk: tamanho (4 bytes) + tipo de compressão (1 byte) + NBT. **Todos os chunks vistos usam zlib (tipo 2)**.

### Chunk com status `terrain` (o que vamos escrever)
```
DataVersion: Int 5023
Status: "minecraft:terrain"
xPos, zPos: Int (coordenada do chunk) ; yPos: Int -4
sections: List de 24 Compound (Y = -4 … 19), cada uma com:
    Y: Byte
    block_states: { palette: List, data: LongArray (se paleta > 1) }
    biomes:       { palette: List<String>, data: LongArray (se paleta > 1) }
Heightmaps: { MOTION_BLOCKING, MOTION_BLOCKING_NO_LEAVES, OCEAN_FLOOR, OCEAN_FLOOR_WG,
              WORLD_SURFACE, WORLD_SURFACE_WG } — LongArray[37] cada
structures: { References: {}, starts: {} }
PostProcessing: List de 24 listas vazias
block_ticks, fluid_ticks, block_entities, entities: listas vazias
InhabitedTime: Long 0 ; LastUpdate: Long
(sem dados de luz, sem isLightOn, sem blending_data)
```

### Paleta de blocos — **novidade do 26.x**
As entradas da paleta não usam mais `Name`/`Properties` para todos:
- bloco sem propriedades: o **texto** `"minecraft:stone"`;
- bloco com propriedades: `{id: "minecraft:water", properties: {level: "0"}}`;
- quando a lista mistura os dois, os textos vêm "embrulhados": `{"": "minecraft:stone"}` (lista heterogênea do NBT novo).

### Compactação
- Blocos: 4096 por seção, índice `y*256 + z*16 + x`, bits = máx(4, ⌈log₂ paleta⌉), entradas não atravessam os longs.
- Biomas: 64 células 4×4×4 por seção, índice `y*16 + z*4 + x`, bits = ⌈log₂ paleta⌉ (mínimo 1).
- Heightmaps: 256 colunas, índice `z*16 + x`, 9 bits, valor = (Y do bloco mais alto + 1) − (−64).
  - `WORLD_SURFACE(_WG)`: qualquer bloco não-ar; `OCEAN_FLOOR(_WG)`: só blocos sólidos (ignora água);
    `MOTION_BLOCKING`: sólidos + líquidos; `_NO_LEAVES`: idem sem folhas.
  - Os `_WG` ("worldgen") são os que as features usam para saber onde pôr árvores — precisam estar certos.

### Verificações feitas
- Ler → regravar um chunk real dá **o mesmo arquivo byte a byte** (o leitor/gravador NBT está correto).
- Descompactar → recompactar os blocos dá **os mesmos dados**.
- Heightmaps decodificados batem 256/256 com os blocos (diferenças só onde esperado: folhas, água sobre o fundo).
