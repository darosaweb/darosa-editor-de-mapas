// Lista de biomas vanilla que o editor oferece.
// id = nome exato no Minecraft; cor = cor no mapa 2D; simples = aparece no modo simples.
// terreno = altura sugerida em relação ao nível do mar quando o "pincel mágico" está ligado
//           (null = não mexe no relevo; só garante que fique acima/abaixo da água).
export const BIOMES = [
  { id: 'minecraft:plains',          nome: 'Planície',          emoji: '🌾', cor: '#8fd16a', simples: true,  agua: false },
  { id: 'minecraft:forest',          nome: 'Floresta',          emoji: '🌳', cor: '#2f8a3a', simples: true,  agua: false },
  { id: 'minecraft:birch_forest',    nome: 'Floresta de bétulas', emoji: '🌲', cor: '#6fbf73', simples: false, agua: false },
  { id: 'minecraft:dark_forest',     nome: 'Floresta escura',   emoji: '🌑', cor: '#1d5a26', simples: false, agua: false },
  { id: 'minecraft:cherry_grove',    nome: 'Cerejeiras',        emoji: '🌸', cor: '#f4a6d0', simples: true,  agua: false },
  { id: 'minecraft:taiga',           nome: 'Taiga',             emoji: '🌲', cor: '#3f6e5a', simples: true,  agua: false },
  { id: 'minecraft:snowy_plains',    nome: 'Neve',              emoji: '⛄', cor: '#f2f7fb', simples: true,  agua: false },
  { id: 'minecraft:snowy_taiga',     nome: 'Taiga com neve',    emoji: '❄️', cor: '#b9d3d6', simples: false, agua: false },
  { id: 'minecraft:desert',          nome: 'Deserto',           emoji: '🏜️', cor: '#f0dc82', simples: true,  agua: false },
  { id: 'minecraft:badlands',        nome: 'Terras áridas',     emoji: '🟧', cor: '#d9773a', simples: false, agua: false },
  { id: 'minecraft:savanna',         nome: 'Savana',            emoji: '🦒', cor: '#c2b24a', simples: true,  agua: false },
  { id: 'minecraft:jungle',          nome: 'Selva',             emoji: '🦜', cor: '#2bb24c', simples: true,  agua: false },
  { id: 'minecraft:swamp',           nome: 'Pântano',           emoji: '🐸', cor: '#5b6b3a', simples: true,  agua: false },
  { id: 'minecraft:mushroom_fields', nome: 'Cogumelos',         emoji: '🍄', cor: '#b07cc6', simples: true,  agua: false },
  { id: 'minecraft:meadow',          nome: 'Prado',             emoji: '🌼', cor: '#a8dd7c', simples: false, agua: false },
  { id: 'minecraft:stony_peaks',     nome: 'Picos de pedra',    emoji: '🪨', cor: '#9a9a9a', simples: false, agua: false },
  { id: 'minecraft:beach',           nome: 'Praia',             emoji: '🏖️', cor: '#fae8a4', simples: false, agua: false },
  { id: 'minecraft:river',           nome: 'Rio',               emoji: '🏞️', cor: '#4aa3df', simples: true,  agua: true, profundidade: 3 },
  { id: 'minecraft:ocean',           nome: 'Oceano',            emoji: '🌊', cor: '#2456b8', simples: true,  agua: true, profundidade: 14 },
  { id: 'minecraft:warm_ocean',      nome: 'Oceano quente',     emoji: '🐠', cor: '#22a6b8', simples: false, agua: true, profundidade: 10 },
  { id: 'minecraft:frozen_ocean',    nome: 'Oceano congelado',  emoji: '🧊', cor: '#8fb0d8', simples: false, agua: true, profundidade: 12 },
];

// Tipo de vila do Minecraft que combina com cada bioma (as vilas vanilla existem em 5 estilos)
const VILA_POR_BIOMA = {
  'minecraft:desert': 'desert', 'minecraft:badlands': 'desert', 'minecraft:beach': 'desert',
  'minecraft:savanna': 'savanna',
  'minecraft:taiga': 'taiga',
  'minecraft:snowy_plains': 'snowy', 'minecraft:snowy_taiga': 'snowy',
};
export const VILA_NOMES = { plains: 'planície', desert: 'deserto', savanna: 'savana', taiga: 'taiga', snowy: 'neve' };
export function tipoDeVila(biomeId) { return VILA_POR_BIOMA[biomeId] || 'plains'; }

export const BIOME_INDEX =Object.fromEntries(BIOMES.map((b, i) => [b.id, i]));
export const OCEAN = BIOME_INDEX['minecraft:ocean'];
export const RIVER = BIOME_INDEX['minecraft:river'];
export const PLAINS = BIOME_INDEX['minecraft:plains'];
export const FOREST = BIOME_INDEX['minecraft:forest'];
export const BEACH = BIOME_INDEX['minecraft:beach'];

// Cores já convertidas em RGB para o desenho rápido
export const BIOME_RGB = BIOMES.map(b => {
  const n = parseInt(b.cor.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
});
