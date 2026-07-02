/**
 * Teste de captura de sessão Shein — corre com: node test-shein-session.mjs [pt|www|es|fr]
 *
 * Corre directamente (sem precisar do sidecar em execução).
 * Abre um browser visível, navega para o Shein e aguarda 5 minutos para
 * o utilizador navegar/resolver o CAPTCHA manualmente.
 * Guarda a sessão em .sessions/pt-direct-seeded.json (usado pelo sidecar automaticamente).
 */

import { captureSheinSession, getSheinSessionStatus } from './src/services/shein-session.js';

const MARKET = process.argv[2] || 'pt';

console.log(`\n🔑  Shein Session Capture — market: ${MARKET}`);

// Verifica estado actual
console.log('\n📊  Estado actual das sessões:');
const sessions = await getSheinSessionStatus();
for (const s of sessions) {
  const icon = s.hasSession ? '✅' : '❌';
  console.log(`  ${icon}  market=${s.market}  cookies=${s.sheinCookieCount}  saved=${s.savedAt ?? 'nunca'}`);
}

console.log(`\n🚀  A iniciar captura para market="${MARKET}"...`);
console.log('   → Browser visível vai abrir. Navega no Shein normalmente.');
console.log('   → Resolve CAPTCHAs se aparecerem.');
console.log('   → A janela fecha automaticamente ao fim de 5 minutos.\n');

try {
  const result = await captureSheinSession(MARKET);
  console.log(`\n✅  Sessão capturada!`);
  console.log(`   market:      ${result.market}`);
  console.log(`   cookies:     ${result.cookieCount}`);
  console.log(`   guardado em: ${result.profilePath}`);
  console.log(`   data:        ${result.savedAt}`);
  console.log('\n💡  Reinicia o sidecar para que use a nova sessão.');
} catch (err) {
  console.error('\n❌  Erro:', err.message);
  process.exit(1);
}
