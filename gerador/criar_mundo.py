"""Um comando só: desenho (.mcmapa) -> mundo pronto para instalar, com imagem e relatório.

  python -I -X utf8 gerador/criar_mundo.py mapas/meu-mapa.mcmapa

Passos:
  1. gera as regiões (terreno, superfície, biomas, cavernas)        -> gerar.py
  2. o Paper de TESTE local completa os chunks e constrói as vilas   -> testar_local.py
  3. copia o resultado para saida/<nome>/mundo-pronto/ (region, entities, poi)
  4. desenha o mundo visto de cima e escreve o relatório

Nada aqui toca na Pi. A instalação na Pi é um passo separado, sempre com aprovação.
"""
import json
import os
import shutil
import subprocess
import sys
import time

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
OVERWORLD = os.path.join(RAIZ, 'teste-servidor', 'dados', 'world', 'dimensions', 'minecraft', 'overworld')
PY = [sys.executable, '-I', '-X', 'utf8']


def rodar(script, *args, capturar=False):
    cmd = PY + [os.path.join(AQUI, script), *args]
    env = {**os.environ, 'PYTHONIOENCODING': 'utf-8'}
    if capturar:
        return subprocess.run(cmd, check=True, capture_output=True, text=True, encoding='utf-8', env=env).stdout
    subprocess.run(cmd, check=True, env=env)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    projeto = os.path.abspath(sys.argv[1])
    mundo_novo = '--mundo-novo' in sys.argv[2:]   # mundo inteiro novo: também Nether e End gerados aqui
    extra = [a for a in sys.argv[2:] if a != '--mundo-novo']   # ex.: --sem-cavernas, --anel 10
    nome = os.path.splitext(os.path.basename(projeto))[0]
    saida = os.path.join(RAIZ, 'saida', nome)
    pronto = os.path.join(saida, 'mundo-pronto')
    t0 = time.time()

    print(f'== 1/4 gerando o terreno de "{nome}"')
    rodar('gerar.py', projeto, saida, *extra)
    print('\n== 2/4 completando no Paper de teste (árvores, minérios, luz, vilas)')
    rodar('testar_local.py', saida, *(['--mundo-novo'] if mundo_novo else []))

    print('\n== 3/4 copiando o mundo pronto')
    info = json.load(open(os.path.join(saida, 'info.json'), encoding='utf-8'))
    shutil.rmtree(pronto, ignore_errors=True)
    copiados = 0
    for sub in ('region', 'entities', 'poi'):      # blocos, aldeões/animais, pontos de interesse (camas, sinos…)
        os.makedirs(os.path.join(pronto, sub))
        for arq in info['regioes']:
            src = os.path.join(OVERWORLD, sub, arq)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(pronto, sub, arq))
                copiados += 1
    print(f'   {copiados} arquivos em {pronto}')
    if mundo_novo:
        # a pasta world inteira (level.dat, data, as 3 dimensões), sem dados de jogadores nem trava do servidor
        destino = os.path.join(saida, 'mundo-novo', 'world')
        shutil.rmtree(os.path.dirname(destino), ignore_errors=True)
        fora = shutil.ignore_patterns('players', 'playerdata', 'stats', 'advancements', 'session.lock')
        shutil.copytree(os.path.dirname(os.path.dirname(os.path.dirname(OVERWORLD))), destino, ignore=fora)
        tam = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(destino) for f in fs)
        print(f'   mundo novo completo: {destino} ({tam / 1e6:.0f} MB)')

    print('\n== 4/4 imagem e relatório')
    resumo = json.loads(rodar('renderizar.py', os.path.join(pronto, 'region'), os.path.join(saida, 'info.json'),
                              os.path.join(saida, 'mundo.png'), capturar=True))
    try:   # recorte só do desenho, ampliado (o anel de oceano fica de fora)
        from PIL import Image
        im = Image.open(os.path.join(saida, 'mundo.png'))
        m = (info['chunks_x'][0] - info['desenho_x'][0] // 16) * -16
        corte = im.crop((m, m, im.size[0] - m, im.size[1] - m))
        escala = max(1, 768 // max(corte.size))
        corte.resize((corte.size[0] * escala, corte.size[1] * escala), Image.NEAREST).save(os.path.join(saida, 'mundo-desenho.png'))
    except Exception as e:  # Pillow é opcional
        print('   (sem recorte ampliado:', e, ')')

    vilas = info.get('vilas_resultado') or []
    linhas = [
        f'Mundo: {nome}',
        f'Desenho: {info["largura"]} x {info["altura"]} blocos, centro em X 0 Z 0; nível do mar {info["nivelMar"]}',
        f'Spawn: X {info["spawn"][0]} Y {info["spawn"][1]} Z {info["spawn"][2]} ({info.get("spawn_origem", "")})',
        f'Borda do mundo: centro {info["borda_centro"]}, tamanho {info["borda_tamanho"]} blocos',
        f'Vilas: {sum(v["ok"] for v in vilas)} de {len(vilas)} construídas'
        + ''.join(f'\n  - {v["estrutura"]} em X {v["x"]} Z {v["z"]}: {"ok" if v["ok"] else v["resposta"]}' for v in vilas),
        '',
        'Conteúdo (contado nos chunks prontos):',
        *[f'  {k}: {v}' for k, v in resumo.items() if k != 'biomas (células)'],
        '',
        'Arquivos para instalar (dimensions/minecraft/overworld/):',
        *[f'  {sub}/{arq}' for sub in ('region', 'entities', 'poi') for arq in info['regioes']
          if os.path.exists(os.path.join(pronto, sub, arq))],
        '',
        *([f'Nether: borda {info["nether"]["borda"]} blocos, chunks prontos {info["nether"]["prontos"]}',
           f'End: borda {info["end"]["borda"]} blocos, chunks prontos {info["end"]["prontos"]}', '']
          if mundo_novo and info.get('nether') else []),
        'Comandos no servidor depois de instalar:',
        f'  setworldspawn {info["spawn"][0]} {info["spawn"][1]} {info["spawn"][2]}',
        f'  worldborder center {info["borda_centro"][0]} {info["borda_centro"][1]}',
        f'  worldborder set {info["borda_tamanho"]}',
        '',
        f'Tempo total: {time.time() - t0:.0f}s',
    ]
    open(os.path.join(saida, 'relatorio.txt'), 'w', encoding='utf-8').write('\n'.join(linhas) + '\n')
    print('\n'.join(linhas))
    print(f'\nPronto! Veja {os.path.join(saida, "mundo-desenho.png")} e {os.path.join(saida, "relatorio.txt")}')


if __name__ == '__main__':
    main()
