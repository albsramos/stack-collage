// Colour themes. "light" follows the reference render: white clay, warm windows, dark solar glass, gold accents.

import { Mat, hex, mat, type RGB } from './core';

export interface Palette {
  night: boolean;
  bg: string;
  ground: string;
  pad: string;
  plaza: string;
  road: string;
  roadLine: string;
  curbHi: string;
  curbLo: string;
  shadow: string;
  ao: string;
  // solids
  white: Mat;
  bright: Mat;
  factory: Mat;
  factoryDark: Mat;
  concrete: Mat;
  steel: Mat;
  dark: Mat;
  rack: Mat;
  rackFront: string;
  crate: Mat;
  planter: Mat;
  // glass, light
  window: [string, string];
  windowNight: [string, string];
  mullion: string;
  glassDark: string;
  solar: string;
  solarLine: string;
  solarFrame: string;
  dockDoor: string;
  glow: string;
  led: string;
  ledBlue: string;
  ledWarm: string;
  // vehicles
  paints: Mat[];
  gold: Mat;
  carGlass: Mat;
  tyre: string;
  headlight: string;
  taillight: string;
  // people & robots
  people: RGB[];
  accents: RGB[];
  robot: string;
  robotHi: string;
  robotHead: string;
  // trees
  leafHi: RGB;
  leafLo: RGB;
  trunk: string;
}

export function lightPalette(): Palette {
  return {
    night: false,
    bg: '#e9e9ed',
    ground: '#ebebef',
    pad: '#e4e4e9',
    plaza: '#efeff2',
    road: '#dcdce2',
    roadLine: '#f6f6f8',
    curbHi: '#f9f9fb',
    curbLo: '#cfd0d7',
    shadow: 'rgba(84, 86, 104, 0.15)',
    ao: 'rgba(70, 72, 92, 0.2)',
    white: mat('#fbfbfc'),
    bright: mat('#ffffff', 0.15),
    factory: mat('#d3d3d9', 0.22),
    factoryDark: mat('#b9bac2', 0.24),
    concrete: mat('#e9e9ed'),
    steel: mat('#f2f2f5', 0.2),
    dark: mat('#3b3d44', 0.35),
    rack: mat('#e6e6ea', 0.2),
    rackFront: '#33353c',
    crate: mat('#efe7d8', 0.2),
    planter: mat('#f3f3f6', 0.18),
    window: ['#fbe9c6', '#e8c58e'],
    windowNight: ['#ffe3a6', '#f0b45c'],
    mullion: 'rgba(120, 110, 96, 0.35)',
    glassDark: '#3a3e4a',
    solar: '#2d3447',
    solarLine: 'rgba(120, 136, 170, 0.35)',
    solarFrame: '#e9e9ee',
    dockDoor: '#5d5f68',
    glow: '#7fe3ff',
    led: '#59e08f',
    ledBlue: '#6ab8ff',
    ledWarm: '#ffc76b',
    paints: [
      mat('#f4f4f6', 0.2), // white
      mat('#f4f4f6', 0.2),
      mat('#c9cad0', 0.24), // silver
      mat('#a7a9b1', 0.26), // grey
      mat('#3d3f46', 0.36), // graphite
      mat('#2b2c31', 0.38), // black
      mat('#d9c7a0', 0.26), // champagne gold
    ],
    gold: mat('#d6c094', 0.28),
    carGlass: mat('#2f323a', 0.32),
    tyre: '#2a2b30',
    headlight: '#ffffff',
    taillight: '#e0605a',
    people: [hex('#e2e3e8'), hex('#d3d4da'), hex('#c4c5cc'), hex('#b3b4bc'), hex('#a0a1aa'), hex('#8a8b94')],
    accents: [hex('#e2b04a'), hex('#d9925a'), hex('#5c5f69'), hex('#8aa0c8')],
    robot: '#2b2c31',
    robotHi: '#6b6e78',
    robotHead: '#17181b',
    leafHi: hex('#ffffff'),
    leafLo: hex('#d3d4dc'),
    trunk: '#a9aab3',
  };
}

export function darkPalette(): Palette {
  return {
    night: true,
    bg: '#17181c',
    ground: '#1b1c21',
    pad: '#1f2026',
    plaza: '#1d1e23',
    road: '#141519',
    roadLine: '#3a3c44',
    curbHi: '#2c2e35',
    curbLo: '#0e0f12',
    shadow: 'rgba(0, 0, 0, 0.34)',
    ao: 'rgba(0, 0, 0, 0.45)',
    white: mat('#43454e', 0.36),
    bright: mat('#4e505a', 0.34),
    factory: mat('#363840', 0.36),
    factoryDark: mat('#2c2e35', 0.36),
    concrete: mat('#2a2c32', 0.32),
    steel: mat('#4a4c55', 0.34),
    dark: mat('#202126', 0.35),
    rack: mat('#33353c', 0.32),
    rackFront: '#121317',
    crate: mat('#5b5548', 0.3),
    planter: mat('#30323a', 0.32),
    window: ['#ffe2a8', '#f2b65e'],
    windowNight: ['#ffe2a8', '#f2b65e'],
    mullion: 'rgba(40, 30, 20, 0.45)',
    glassDark: '#101116',
    solar: '#121725',
    solarLine: 'rgba(90, 110, 150, 0.32)',
    solarFrame: '#3a3c44',
    dockDoor: '#121317',
    glow: '#6fdcff',
    led: '#59e08f',
    ledBlue: '#6ab8ff',
    ledWarm: '#ffc76b',
    paints: [
      mat('#7d808a', 0.34),
      mat('#6c6f78', 0.34),
      mat('#555861', 0.36),
      mat('#3e4048', 0.36),
      mat('#2b2c32', 0.38),
      mat('#1f2025', 0.38),
      mat('#9c8a63', 0.34),
    ],
    gold: mat('#a8915f', 0.34),
    carGlass: mat('#14151a', 0.3),
    tyre: '#0b0b0d',
    headlight: '#fff6dc',
    taillight: '#ff5a50',
    people: [hex('#6a6c76'), hex('#61636c'), hex('#575962'), hex('#4c4e57'), hex('#7a7c86'), hex('#444650')],
    accents: [hex('#d9a440'), hex('#c98450'), hex('#2c2e35'), hex('#6f84ad')],
    robot: '#0f1013',
    robotHi: '#3d4049',
    robotHead: '#08080a',
    leafHi: hex('#4a4d57'),
    leafLo: hex('#2a2c33'),
    trunk: '#3a3c44',
  };
}

export type { Mat };
