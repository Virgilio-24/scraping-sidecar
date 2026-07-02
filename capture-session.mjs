/**
 * Captura sessão para qualquer site suportado.
 * Corre com: node capture-session.mjs <site>
 *
 * Sites disponíveis:
 *   shein-pt, shein-www, shein-es
 *   temu
 *   amazon-pt, amazon-com, amazon-uk
 *   zalando, zara, hm, aliexpress, pullandbear, bershka
 *
 * Exemplo: node capture-session.mjs temu
 */

import { captureSession, getAllSessionStatus, SITE_CONFIGS } from './src/services/session-manager.js';

const site = process.argv[2];

if (!site || site === '--status') {
  console.log('\n📊  Estado actual das sessões:\n');
  const sessions = await getAllSessionStatus();
  for (const s of sessions) {
    const icon = s.hasSession ? '✅' : '❌';
    const saved = s.savedAt ? new Date(s.savedAt).toLocaleString('pt-PT') : 'nunca';
    console.log(`  ${icon}  ${s.site.padEnd(14)} ${s.name.padEnd(20)} cookies=${s.cookieCount}  saved=${saved}`);
  }
  console.log('\nUso: node capture-session.mjs <site>');
  console.log('Sites:', Object.keys(SITE_CONFIGS).join(', '));
  process.exit(0);
}

if (!SITE_CONFIGS[site]) {
  console.error(`\n❌  Site desconhecido: "${site}"`);
  console.error('Sites disponíveis:', Object.keys(SITE_CONFIGS).join(', '));
  process.exit(1);
}

const cfg = SITE_CONFIGS[site];
console.log(`\n🔑  Captura de sessão — ${cfg.name}`);
console.log(`📡  A abrir: ${cfg.startUrl}`);
console.log(`\n   → Browser vai abrir. Navega normalmente e resolve CAPTCHAs.`);
console.log(`   → A janela fecha automaticamente ao fim de 5 minutos.\n`);

try {
  const result = await captureSession(site);
  console.log(`\n✅  Sessão capturada!`);
  console.log(`   site:        ${result.site} (${result.name})`);
  console.log(`   profileKey:  ${result.profileKey}`);
  console.log(`   cookies:     ${result.cookieCount}`);
  console.log(`   guardado em: ${result.profilePath}`);
  console.log(`   data:        ${result.savedAt}`);
  console.log(`\n💡  O sidecar vai usar esta sessão automaticamente.`);
} catch (err) {
  console.error('\n❌  Erro:', err.message);
  process.exit(1);
}
