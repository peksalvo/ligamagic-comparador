/**
 * Service worker: única parte que fala com a rede.
 *
 * Estratégia de resolução, em duas passadas:
 *   1. por print exato -> { set, collector_number }
 *   2. o que não foi encontrado, por nome -> { name }
 *
 * A segunda passada existe porque um único erro na detecção do set code fazia
 * o lote inteiro voltar vazio e a página ficar sem nenhum selo. Com o retry,
 * qualquer falha de edição degrada para "preço de outro print" (marcado como
 * aproximado) em vez de silêncio.
 */

const SCRYFALL_COLLECTION = "https://api.scryfall.com/cards/collection";
const SCRYFALL_SETS = "https://api.scryfall.com/sets";
const FX_ENDPOINT = "https://economia.awesomeapi.com.br/last/USD-BRL,EUR-BRL";

const PRICE_TTL = 12 * 60 * 60 * 1000; // Scryfall atualiza preços 1x/dia
const MISS_TTL = 6 * 60 * 60 * 1000; // curto: um "não achei" costuma ser bug meu, não do Scryfall
const FX_TTL = 6 * 60 * 60 * 1000;
const SETS_TTL = 30 * 24 * 60 * 60 * 1000; // a lista de sets muda algumas vezes por ano

const CHUNK = 75; // limite do endpoint /cards/collection
const CHUNK_DELAY = 130; // Scryfall pede 50-100ms entre chamadas

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VERSION = chrome.runtime.getManifest().version;

/**
 * Um "não encontrei" e um "aproximado" quase sempre são bug de identificação da
 * extensão, não ausência no Scryfall. Cachear isso sem invalidar na atualização
 * faz o bug sobreviver à própria correção: a versão nova pede a mesma chave, acha
 * o erro no cache e nem consulta a API. Então toda troca de versão limpa os dois.
 */
let purge = null;
function purgeStaleOnUpgrade() {
  if (!purge) {
    purge = (async () => {
      const { lmi_version } = await chrome.storage.local.get("lmi_version");
      if (lmi_version === VERSION) return;
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter(
        (k) => (k.startsWith("p:") || k.startsWith("n:")) && (all[k]?.missing || all[k]?.approx)
      );
      if (keys.length) await chrome.storage.local.remove(keys);
      await chrome.storage.local.set({ lmi_version: VERSION });
    })();
  }
  return purge;
}

/**
 * Cartas duplas, split e com aventura vêm da Liga como "A // B". O nome composto
 * depende de espaçamento, ordem das faces e encoding — coisas que a Liga pode
 * formatar de outro jeito que o Scryfall. A face frontal é a parte estável.
 */
const frontFace = (name) => String(name || "").split("//")[0].trim();

function keyFor(card) {
  return card.set && card.collector_number
    ? `p:${card.set}/${card.collector_number}`
    : `n:${String(card.name || "").toLowerCase()}`;
}

/**
 * Lista de códigos de set do Scryfall, em cache longo. Serve para VALIDAR um
 * código antes de gastar requisição com ele — sem isso, derivar códigos seria
 * gerar chutes.
 */
async function getSetCodes() {
  const { lmi_sets } = await chrome.storage.local.get("lmi_sets");
  if (lmi_sets && Date.now() - lmi_sets.ts < SETS_TTL) return new Set(lmi_sets.codes);

  try {
    const res = await fetch(SCRYFALL_SETS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const codes = (json.data || []).map((s) => String(s.code).toLowerCase()).filter(Boolean);
    if (!codes.length) throw new Error("lista vazia");
    await chrome.storage.local.set({ lmi_sets: { ts: Date.now(), codes } });
    return new Set(codes);
  } catch {
    // Cache expirado ainda é melhor que nada; sem cache, segue sem validação.
    return lmi_sets ? new Set(lmi_sets.codes) : null;
  }
}

/**
 * A Liga inventa códigos para variantes de acabamento, prefixando o código real:
 *   FNSOS = Field Notes + SOS      RFBRO = Retro Frame + BRO
 * Esses códigos não existem no Scryfall, e pedir por eles dá 404 — o que fazia a
 * extensão cair na busca por nome e devolver o preço do print BASE. Duas versões
 * diferentes da mesma carta na mesma edição terminavam com preços idênticos.
 *
 * A recuperação é pelo sufixo, sempre o mais longo que seja um set de verdade.
 * Mínimo de 3 caracteres porque é o tamanho da maioria dos códigos reais.
 */
function resolveSetCode(code, codes) {
  const c = String(code || "").toLowerCase();
  if (!c) return null;
  if (!codes) return c; // sem lista para validar, usa como veio
  if (codes.has(c)) return c;

  for (let len = c.length - 1; len >= 3; len--) {
    const tail = c.slice(-len);
    if (codes.has(tail)) return tail;
  }
  return null; // desconhecido: vai direto para busca por nome, sem gastar requisição
}

async function getFx() {
  const { lmi_fx } = await chrome.storage.local.get("lmi_fx");
  if (lmi_fx && Date.now() - lmi_fx.ts < FX_TTL) return lmi_fx.rates;

  const res = await fetch(FX_ENDPOINT);
  if (!res.ok) throw new Error(`Câmbio indisponível (HTTP ${res.status})`);
  const json = await res.json();

  const rates = {
    usd: parseFloat(json?.USDBRL?.bid),
    eur: parseFloat(json?.EURBRL?.bid),
  };
  if (!rates.usd || !rates.eur) throw new Error("Câmbio retornou valores inválidos");

  await chrome.storage.local.set({ lmi_fx: { ts: Date.now(), rates } });
  return rates;
}

async function scryfallCollection(identifiers) {
  const res = await fetch(SCRYFALL_COLLECTION, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifiers }),
  });
  if (!res.ok) throw new Error(`Scryfall respondeu HTTP ${res.status}`);
  return res.json();
}

function entryFromScryfall(card) {
  const p = card.prices || {};
  return {
    name: card.name,
    set: card.set,
    cn: card.collector_number,
    usd: p.usd ? parseFloat(p.usd) : null,
    usd_foil: p.usd_foil ? parseFloat(p.usd_foil) : null,
    eur: p.eur ? parseFloat(p.eur) : null,
    eur_foil: p.eur_foil ? parseFloat(p.eur_foil) : null,
    url: card.scryfall_uri || null,
    ts: Date.now(),
  };
}

/**
 * Uma passada de resolução. `byName = true` ignora set/collector_number e
 * pergunta só pelo nome.
 */
async function lookup(list, byName) {
  const resolved = new Map();

  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    const identifiers = slice.map(({ card }) =>
      !byName && card.set && card.collector_number
        ? { set: card.set, collector_number: String(card.collector_number) }
        : { name: byName ? frontFace(card.name) : card.name }
    );

    if (i > 0) await sleep(CHUNK_DELAY);
    const json = await scryfallCollection(identifiers);

    // A ordem da resposta não é garantida quando há not_found, então indexamos
    // por print e por nome em vez de confiar na posição.
    const byPrint = new Map();
    const byNameIdx = new Map();
    for (const card of json.data || []) {
      byPrint.set(`${card.set}/${card.collector_number}`, card);
      // Indexa pelo nome completo E pela face frontal: pedimos por uma forma e o
      // Scryfall responde com a outra.
      for (const n of [card.name.toLowerCase(), frontFace(card.name).toLowerCase()]) {
        if (!byNameIdx.has(n)) byNameIdx.set(n, card);
      }
    }

    for (const { key, card } of slice) {
      let found = null;
      if (!byName && card.set && card.collector_number) {
        found = byPrint.get(`${card.set}/${card.collector_number}`) || null;
        // Código derivado por sufixo pode, em teoria, acertar um set existente e
        // uma carta errada. Confere o nome antes de aceitar.
        if (found && frontFace(found.name).toLowerCase() !== frontFace(card.name).toLowerCase()) {
          found = null;
        }
      }
      if (!found) found = byNameIdx.get(String(card.name || "").toLowerCase()) || null;
      if (!found) found = byNameIdx.get(frontFace(card.name).toLowerCase()) || null;
      if (!found) continue;

      const entry = entryFromScryfall(found);
      // Marca como aproximado sempre que o preço não é do print pedido.
      if (byName || (card.set && found.set !== card.set)) {
        entry.approx = true;
        entry.wantedSet = card.set || null;
      }
      resolved.set(key, entry);
    }
  }

  return resolved;
}

async function resolvePrices(cards) {
  await purgeStaleOnUpgrade();
  const codes = await getSetCodes();

  /**
   * Resolver o set muda a chave (FNSOS/296 -> SOS/296), então precisamos das
   * duas: a de SAÍDA, que é a que o content script calculou e vai procurar na
   * resposta, e a de CACHE/CONSULTA, já resolvida. Duas chaves de saída podem
   * apontar para a mesma chave resolvida.
   */
  const groups = new Map(); // cacheKey -> { card, outKeys: [] }
  for (const c of cards) {
    const outKey = keyFor(c);
    const set = c.set ? resolveSetCode(c.set, codes) : null;
    const card = { ...c, set, collector_number: set ? c.collector_number : null };
    const cacheKey = keyFor(card);
    if (!groups.has(cacheKey)) groups.set(cacheKey, { card, outKeys: [] });
    const g = groups.get(cacheKey);
    if (!g.outKeys.includes(outKey)) g.outKeys.push(outKey);
  }

  const cached = await chrome.storage.local.get([...groups.keys()]);
  const resolved = new Map(); // cacheKey -> entry
  const misses = [];

  for (const [cacheKey, g] of groups) {
    const hit = cached[cacheKey];
    const ttl = hit?.missing ? MISS_TTL : PRICE_TTL;
    if (hit && Date.now() - hit.ts < ttl) resolved.set(cacheKey, hit);
    else misses.push({ key: cacheKey, card: g.card });
  }

  const stats = { requested: groups.size, cached: resolved.size, byPrint: 0, byName: 0, missing: 0 };
  const toStore = {};

  if (misses.length) {
    // passada 1: print exato
    const first = await lookup(misses, false);
    for (const [key, entry] of first) {
      resolved.set(key, entry);
      toStore[key] = entry;
      stats.byPrint++;
    }

    // passada 2: o que sobrou, por nome
    const leftover = misses.filter((m) => !first.has(m.key));
    if (leftover.length) {
      await sleep(CHUNK_DELAY);
      let second = new Map();
      try {
        second = await lookup(leftover, true);
      } catch {
        // se a segunda passada falhar, mantemos o resultado da primeira
      }
      for (const { key, card } of leftover) {
        const entry = second.get(key) || { missing: true, name: card.name, ts: Date.now() };
        resolved.set(key, entry);
        toStore[key] = entry;
        if (entry.missing) stats.missing++;
        else stats.byName++;
      }
    }
  }

  if (Object.keys(toStore).length) await chrome.storage.local.set(toStore);

  // Reindexa pelas chaves de saída antes de responder.
  const out = {};
  for (const [cacheKey, g] of groups) {
    const entry = resolved.get(cacheKey);
    if (!entry) continue;
    for (const k of g.outKeys) out[k] = entry;
  }
  return { prices: out, stats };
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === "GET_PRICES") {
    (async () => {
      try {
        const [fx, resolved] = await Promise.all([getFx(), resolvePrices(msg.cards)]);
        respond({ ok: true, fx, prices: resolved.prices, stats: resolved.stats });
      } catch (err) {
        respond({ ok: false, error: String(err.message || err) });
      }
    })();
    return true;
  }

  if (msg?.type === "CLEAR_CACHE") {
    (async () => {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter(
        (k) => k.startsWith("p:") || k.startsWith("n:") || k === "lmi_fx"
      );
      await chrome.storage.local.remove(keys);
      respond({ ok: true, removed: keys.length });
    })();
    return true;
  }
});
