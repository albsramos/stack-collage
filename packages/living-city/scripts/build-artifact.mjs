// Builds artifact-dist/living-city.html: the demo page with the component bundle inlined.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

execFileSync('npx', ['vite', 'build', '--config', 'vite.artifact.config.ts', '--logLevel', 'warn'], { stdio: 'inherit' });
const bundle = readFileSync('artifact-dist/living-city.iife.js', 'utf8').replace(/<\/script/gi, '<\\/script');
const page = readFileSync('artifact/page.html', 'utf8');
if (!page.includes('/*BUNDLE*/')) throw new Error('artifact/page.html has no /*BUNDLE*/ marker');
writeFileSync('artifact-dist/living-city.html', page.replace('/*BUNDLE*/', () => bundle));
console.log(`artifact-dist/living-city.html  ${(Buffer.byteLength(readFileSync('artifact-dist/living-city.html')) / 1024).toFixed(0)} kB`);
