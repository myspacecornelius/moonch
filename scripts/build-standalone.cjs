/* Produce one portable HTML file. No server, assets, or build runtime needed to use it. Private evidence modules are never embedded. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const hash = text => "'sha256-" + crypto.createHash('sha256').update(text).digest('base64') + "'";
let html = read('index.html');
const names = [...html.matchAll(/<script defer src="([^"]+)"><\/script>/g)].map(match => match[1]);
if (names.length !== 15) throw new Error('Unexpected source script count: expected 15 scripts.');
if (names.some(name => /-audit|evidence-module|model-run/.test(name))) throw new Error('Private modules must not be bundled.');
const bootstrap = "window.addEventListener('error',function(event){var note=document.getElementById('startup-details');if(note)note.textContent='Startup error: '+(event.message||'A script could not load')+'. Please open this downloaded file in a current browser.';});";
const scripts = [bootstrap, ...names.map(name => read(name).replace(/<\/script/gi, '<\\/script'))];
/* Every <link rel="stylesheet" href="x.css"> becomes its own inline <style> block with its own hash in style-src. */
const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(match => ({name: match[1], css: read(match[1]).replace(/^@charset[^;]+;\s*/, '')}));
if (!sheets.length || sheets.some(sheet => !/^[a-z-]+\.css$/.test(sheet.name) || /-audit|evidence-module|model-run/.test(sheet.name))) throw new Error('Unexpected stylesheet links in index.html.');
if (sheets.some(sheet => /<\/style/i.test(sheet.css))) throw new Error('A stylesheet contains a closing style tag.');
const csp = `default-src 'none'; script-src ${scripts.map(hash).join(' ')}; style-src ${sheets.map(sheet => hash(sheet.css)).join(' ')}; img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
html = html.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/, `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (tag, name) => `<style>${sheets.find(sheet => sheet.name === name).css}</style>`);
if (/<link[^>]+rel="stylesheet"/.test(html)) throw new Error('A stylesheet link was left in the standalone page.');
html = html.replace(/  <script defer src="[^"]+"><\/script>\n/g, '');
html = html.replace('</body>', () => scripts.map(script => `<script>${script}</script>`).join('\n') + '\n</body>');
const target = path.join(root, 'Finance_Task_Studio.html');
fs.writeFileSync(target, html);
console.log(JSON.stringify({file: target, bytes: Buffer.byteLength(html), sha256: crypto.createHash('sha256').update(html).digest('hex')}));
