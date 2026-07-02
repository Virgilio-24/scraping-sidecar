/**
 * Teste de captura de sessão Shein — corre com: node test-shein-session.mjs
 *
 * Abre um browser visível, navega para o Shein e aguarda 5 minutos para
 * o utilizador navegar/resolver o CAPTCHA manualmente.
 * No final guarda a sessão e mostra os cookies capturados.
 *
 * Depois de capturar, o sidecar usa automaticamente a sessão nos pedidos.
 */

import fetch from 'node-fetch';

const BASE = process.env.SIDECAR_URL || 'http://localhost:3001';
const MARKET = process.argv[2] || 'pt';

console.log(`\n🔑  Shein Session Capture — market: ${MARKET}`);
console.log(`📡  Sidecar: ${BASE}\n`);

// Verifica estado actual
console.log('📊  Estado actual das sessões:');
const statusRes = await fetch(`${BASE}/shein/session/status`);
const statusData = await statusRes.json();
for (const s of statusData.sessions ?? []) {
  const icon = s.hasSession ? '✅' : '❌';
  console.log(`  ${icon}  market=${s.market}  cookies=${s.sheinCookieCount}  saved=${s.savedAt ?? 'nunca'}`);
}

console.log(`\n🚀  A iniciar captura para market="${MARKET}"...`);
console.log('   → Browser visível vai abrir. Navega no Shein normalmente.');
console.log('   → Resolve CAPTCHAs se aparecerem.');
console.log('   → A janela fecha automaticamente ao fim de 5 minutos.\n');

const captureRes = await fetch(`${BASE}/shein/session/capture`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ market: MARKET }),
});

if (!captureRes.ok) {
  const err = await captureRes.json();
  console.error('❌  Erro na captura:', err.message);
  process.exit(1);
}

const captureData = await captureRes.json();
console.log(`\n✅  Sessão capturada!`);
console.log(`   market:      ${captureData.market}`);
console.log(`   cookies:     ${captureData.cookieCount}`);
console.log(`   guardado em: ${captureData.profilePath}`);
console.log(`   data:        ${captureData.savedAt}`);

// Testa o scrape com a nova sessão
const testUrl = MARKET === 'pt'
  ? 'https://pt.shein.com/SHEIN-Vestido-estampado-de-girassol-para-mulher-p-11671551-cat-1727.html'
  : 'https://www.shein.com/SHEIN-Sunflower-print-dress-p-11671551-cat-1727.html';

console.log(`\n🧪  A testar scrape com a nova sessão...`);
console.log(`   URL: ${testUrl}\n`);

const scrapeRes = await fetch(`${BASE}/product?url=${encodeURIComponent(testUrl)}`);
const scrapeData = await scrapeRes.json();

if (scrapeData.status === 'ok') {
  const d = scrapeData.data;
  console.log(`✅  Scrape bem-sucedido!`);
  console.log(`   title:    ${d.title ?? '—'}`);
  console.log(`   price:    ${d.price?.amount ?? '—'}`);
  console.log(`   images:   ${d.images?.length ?? 0}`);
  console.log(`   sizes:    ${d.sizes?.join(', ') || '—'}`);
  console.log(`   source:   ${d.sourceChain?.join(' → ') || '—'}`);
} else {
  console.log(`⚠️   Scrape falhou: ${scrapeData.message}`);
  console.log('    (Pode ser necessário mais tempo de navegação para estabelecer sessão válida)');
}
