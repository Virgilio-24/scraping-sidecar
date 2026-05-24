# SHEIN Scraping Sidecar

API separada, criada ao lado do projeto original, para obter dados de produto da SHEIN com esta ordem de prioridade:

1. Respostas JSON de rede da propria pagina carregada no browser headless
2. Dados estruturados JSON-LD presentes na pagina
3. Regex no HTML renderizado, apenas como ultimo fallback

Tambem inclui mitigacoes basicas anti-bot:

- persistencia de sessao/cookies por mercado e proxy
- prewarm da homepage antes do produto
- retries com rotacao entre acesso direto e proxies configurados
- round-robin real entre acesso direto e cada proxy configurado
- metricas em memoria por candidato, com sucessos, falhas e ultima causa

## Requisitos

- Node.js 20+

## Instalar

```bash
npm install
npx playwright install chromium
```

## Executar

```bash
npm start
```

## Variaveis uteis

- `RETRY_ATTEMPTS`: numero total de tentativas por pedido
- cada round tenta `direct` e todos os proxies uma vez, em ordem round-robin
- `PREWARM_HOME_MS`: tempo de espera depois de abrir a homepage
- `SESSION_STATE_DIR`: pasta onde os cookies/sessoes ficam persistidos
- `PROXY_URLS`: lista separada por virgula com proxies no formato `http://user:pass@host:port`

Servidor por omissao: `http://localhost:3001`

## Endpoints

- `GET /api/health`
- `GET /api/proxy-metrics`
- `GET /api/product?url=https://pt.shein.com/...-p-94340020.html`

## Resposta esperada

```json
{
  "status": "ok",
  "data": {
    "goodsId": "94340020",
    "goodsSn": "...",
    "title": "...",
    "color": "...",
    "price": {
      "amount": "9.37",
      "formatted": "9,37€",
      "retailAmount": "12.49",
      "retailFormatted": "12,49€",
      "discountPercent": "26"
    },
    "images": ["..."],
    "sourceChain": ["network-json", "json-ld"]
  }
}
```

## Notas

- A SHEIN responde de forma diferente a pedidos simples sem contexto de browser.
- Em alguns casos pode surgir verificacao anti-bot. Quando isso acontece, a API devolve erro de upstream em vez de inventar dados.
- A rotacao de proxies so entra em acao quando `PROXY_URLS` estiver preenchido.
- Quando nenhuma opcao resulta, a resposta inclui `details.attemptHistory` e `details.proxyMetrics`.
