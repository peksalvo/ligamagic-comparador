/**
 * Content script.
 *
 * Princípio: nenhum seletor CSS da LigaMagic. A extensão ancora em duas coisas
 * estáveis — o formato do link da carta (?view=cards/card&card=<nome em inglês>&num=<cn>)
 * e o padrão de texto "R$ 0,00".
 *
 * Duas rotas distintas:
 *   - listagem (grid ou lista): uma faixa por card, inserida abaixo da linha de preços
 *   - página da carta: uma linha logo abaixo do nome em inglês
 */

const CARD_LINK = 'a[href*="cards/card"], a[href*="cards%2Fcard"]';
const PRICE_RE = /R\$\s?([\d.]{1,12},\d{2})/g;

const DEFAULTS = {
  market: "min", // "usd" | "eur" | "min"
  importFactor: 1.0,
  ligaAnchor: "min", // "min" | "max"
  neutralBand: 5,
};

const state = { cfg: DEFAULTS, fx: null, counts: { total: 0, cheaper: 0, approx: 0, missing: 0 } };

/* ---------- utilidades de texto ---------- */

function pricesIn(el) {
  const out = [];
  if (!el) return out;
  for (const m of (el.textContent || "").matchAll(PRICE_RE)) {
    const n = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
    if (n > 0) out.push(n); // ordem do documento, não ordenado
  }
  return out;
}

const hasPrice = (el) => /R\$\s?\d/.test(el?.textContent || "");

const fmtBRL = (n) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/* ---------- identificação ---------- */

/**
 * Cartas duplas/split/aventura chegam como "A %2F%2F B", e o espaçamento em volta
 * do separador varia. Normaliza para a forma que o Scryfall usa.
 */
function normalizeName(name) {
  if (!name) return null;
  return name.replace(/\s+/g, " ").replace(/\s*\/\/\s*/g, " // ").trim();
}

function parseCardHref(href) {
  try {
    const p = new URL(href, location.origin).searchParams;
    return { en: normalizeName(p.get("card")), pt: p.get("aux"), num: p.get("num") };
  } catch {
    return { en: null, pt: null, num: null };
  }
}

function cardIdOf(anchor) {
  const i = parseCardHref(anchor.href);
  return i.en ? `${i.en}|${i.num || ""}` : null;
}

/**
 * Set code é propriedade da CARTA, não da página.
 *
 * Só existe um código válido para a página inteira quando a própria URL diz que
 * a página é uma edição (`card=ed=kld`). Numa busca por nome arbitrária cada
 * linha é de uma edição diferente, e aplicar um código de página a todas produz
 * preços errados com aparência de corretos — pior que não ter código, porque a
 * busca por nome pelo menos vem marcada como aproximada.
 *
 * Por isso: nada de varrer o DOM procurando "(XXX)". Só a URL.
 */
function pageSetCode() {
  // O parâmetro pode chegar com espaço no fim (card=ed%3Decl+ -> "ed=ecl ").
  const cardParam = (new URLSearchParams(location.search).get("card") || "").trim();
  const m = cardParam.match(/^ed=([A-Za-z0-9]{3,6})$/);
  if (!m || isYear(m[1])) return null;
  return m[1].toLowerCase();
}

const isYear = (s) => /^(19|20)\d{2}$/.test(s);

/**
 * Quando o preço não vem do print pedido, marca como aproximado. Sem set code,
 * o collector number da Liga serve de conferência: se o print que o Scryfall
 * devolveu tem outro número, é outra impressão.
 */
function withAccuracy(entry, numHint) {
  if (entry.approx || !numHint || !entry.cn) return entry;
  if (String(entry.cn) === String(numHint)) return entry;
  return { ...entry, approx: true };
}

function keyFor(card) {
  return card.set && card.collector_number
    ? `p:${card.set}/${card.collector_number}`
    : `n:${String(card.name || "").toLowerCase()}`;
}

/* ---------- descoberta do tile (listagem) ---------- */

/**
 * Agrupa as âncoras por carta primeiro. Sem isso, o link da imagem e o link do
 * nome resolvem para ancestrais diferentes e a carta recebe dois selos.
 */
function groupAnchors() {
  const groups = new Map();
  for (const a of document.querySelectorAll(CARD_LINK)) {
    const id = cardIdOf(a);
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(a);
  }
  return groups;
}

function tileForGroup(id, anchors) {
  let el = anchors[0];
  for (let i = 0; i < 10; i++) {
    el = el.parentElement;
    if (!el || el === document.body) return null;
    if (!anchors.every((a) => el.contains(a))) continue;
    if (!hasPrice(el)) continue;
    const foreign = [...el.querySelectorAll(CARD_LINK)].some((a) => {
      const other = cardIdOf(a);
      return other && other !== id;
    });
    if (foreign) return null; // subimos demais e caímos no grid
    return el;
  }
  return null;
}

/**
 * O tile da busca arbitrária tem ALTURA FIXA e a linha de botões ancorada no
 * rodapé. A faixa entra no fluxo, cai em cima dessa área e é encoberta — e o
 * efeito é pior em carta com nome em português, porque a linha extra de texto
 * empurra a faixa mais para baixo ainda.
 *
 * Então, em vez de procurar um lugar onde a faixa caiba, afrouxa a restrição:
 * libera altura, max-height e overflow na cadeia entre a faixa e o tile, e dá ao
 * tile a altura original mais a da faixa. Funciona nos dois layouts — se a linha
 * de botões é absoluta, ela desce junto com o rodapé do tile; se está no fluxo,
 * ela simplesmente deixa de ser cortada.
 */
function relaxChain(strip, tile, extra) {
  const applied = [];
  const set = (el, prop, value) => {
    applied.push([el, prop, el.style[prop]]);
    el.style[prop] = value;
  };

  /**
   * Na busca arbitrária os tiles são inline-block, alinhados pela baseline:
   * mudar a altura de um desloca os vizinhos da mesma linha e a fileira vira
   * escada. `vertical-align: top` desliga essa dependência. Na visão por edição
   * os tiles são itens de grid/flex esticados e nada disso se aplica — daí o
   * problema aparecer só em um dos dois layouts.
   */
  const unbaseline = (el) => {
    if (!el) return;
    const cs = getComputedStyle(el);
    if (cs.display.startsWith("inline") && cs.verticalAlign !== "top") set(el, "verticalAlign", "top");
  };

  for (let el = strip.parentElement; el; el = el.parentElement) {
    const cs = getComputedStyle(el);
    unbaseline(el);
    if (cs.overflow !== "visible") set(el, "overflow", "visible");
    if (cs.maxHeight !== "none") set(el, "maxHeight", "none");

    // Só mexe na altura quando o conteúdo de fato não cabe. Antes, qualquer
    // altura fixa era reescrita, mesmo quando a faixa já caberia.
    if (cs.height !== "auto" && el.scrollHeight > el.clientHeight + 1) {
      const h = parseFloat(cs.height);
      set(el, "height", "auto");
      if (h > 0) set(el, "minHeight", `${h + extra}px`);
    }
    if (el === tile) break;
  }

  // A célula que contém o tile também pode ser a inline-block da fileira.
  unbaseline(tile.parentElement);

  // Sem o undo, quando o fallback dispara a altura extra fica sobrando como
  // espaço vazio embaixo do tile.
  return () => {
    for (const [el, prop, prev] of applied.reverse()) el.style[prop] = prev;
  };
}

/**
 * Cobertura só conta quando quem está por cima PERTENCE AO TILE.
 *
 * O problema estrutural que o fallback existe para resolver é a linha de botões
 * do próprio tile. Já um preview de hover — a Liga abre uma carta ampliada que
 * cobre os tiles vizinhos — é estado transitório e não diz nada sobre o layout:
 * tratá-lo como cobertura jogava a faixa para o topo de tiles que estavam
 * perfeitos.
 */
function isCovered(strip, tile) {
  const s = strip.getBoundingClientRect();
  if (s.height < 4) return true;

  const x = s.left + Math.min(24, s.width / 2);
  const y = s.top + s.height / 2;
  if (y < 0 || y > innerHeight || x < 0 || x > innerWidth) return false; // fora da viewport: não dá para testar

  const top = document.elementFromPoint(x, y);
  if (!top || top === strip || strip.contains(top)) return false;
  return tile.contains(top);
}

function placeStrip(tile, strip) {
  const row = priceRow(tile);
  if (row !== tile && row.parentElement) row.parentElement.insertBefore(strip, row.nextSibling);
  else tile.appendChild(strip);

  const undo = relaxChain(strip, tile, strip.getBoundingClientRect().height || 18);
  if (!isCovered(strip, tile)) return;

  // Último recurso: topo do tile, acima da arte.
  undo();
  strip.remove();
  strip.classList.add("lmi-top");
  tile.insertBefore(strip, tile.firstChild);
}

/** O menor elemento do tile que ainda contém todos os preços — a linha de preços. */
function priceRow(tile) {
  const total = pricesIn(tile).length;
  let best = tile;
  for (const el of tile.querySelectorAll("*")) {
    if (el.querySelector("img")) continue;
    if (pricesIn(el).length !== total) continue;
    if ((el.textContent || "").length < (best.textContent || "").length) best = el;
  }
  return best;
}

/* ---------- comparação ---------- */

/**
 * Todos os mercados disponíveis para o print, já em reais e já com o fator de
 * importação aplicado — assim os dois números do tooltip são comparáveis entre si
 * e com o preço da Liga.
 */
function foreignOptions(entry, foil) {
  const usd = foil ? entry.usd_foil ?? entry.usd : entry.usd;
  const eur = foil ? entry.eur_foil ?? entry.eur : entry.eur;
  const f = state.cfg.importFactor;
  const opts = [];
  if (usd && state.fx.usd)
    opts.push({ src: "TCG", label: "TCGplayer", raw: usd, cur: "US$", brl: usd * state.fx.usd * f });
  if (eur && state.fx.eur)
    opts.push({ src: "CM", label: "Cardmarket", raw: eur, cur: "€", brl: eur * state.fx.eur * f });
  return opts;
}

function pickOption(opts) {
  if (!opts.length) return null;
  if (state.cfg.market === "usd") return opts.find((o) => o.src === "TCG") || opts[0];
  if (state.cfg.market === "eur") return opts.find((o) => o.src === "CM") || opts[0];
  return opts.reduce((a, b) => (a.brl <= b.brl ? a : b));
}

/** Uma linha por mercado: sigla, delta e o preço já convertido. */
function marketLine(opt, ligaPrice) {
  const band = state.cfg.neutralBand;
  const delta = (ligaPrice / opt.brl - 1) * 100;
  const cheaper = delta < -band;
  const cls = cheaper ? "lmi-cheap" : delta > band ? "lmi-pricey" : "lmi-even";
  const arrow = cheaper ? "▼" : delta > band ? "▲" : "≈";

  return {
    cheaper,
    html:
      `<span class="lmi-line ${cls}">` +
      `<span class="lmi-mk">${opt.src}</span>` +
      `<span class="lmi-delta">${arrow} ${Math.abs(delta).toFixed(0)}%</span>` +
      `<span class="lmi-ref">${fmtBRL(opt.brl)}</span>` +
      `</span>`,
  };
}

function buildStrip(entry, ligaPrice, foil, variant, label) {
  const strip = document.createElement("div");
  strip.className = `lmi-strip${variant ? " lmi-" + variant : ""}`;
  const head = label ? `<span class="lmi-label">${label}</span>` : "";

  const opts = foreignOptions(entry, foil);
  const ref = pickOption(opts);
  if (!ref) {
    strip.classList.add("lmi-none");
    strip.innerHTML = `${head}<span class="lmi-line">sem referência${foil ? " foil" : ""}</span>`;
    return strip;
  }

  // Os dois mercados aparecem na faixa, não só o escolhido. O configurado ainda
  // decide o que entra na contagem do resumo — daí o `ref` separado.
  const lines = opts.map((o) => marketLine(o, ligaPrice));
  strip.innerHTML = head + lines.map((l) => l.html).join("");

  if (lines[opts.indexOf(ref)]?.cheaper) state.counts.cheaper++;
  if (entry.approx) {
    strip.classList.add("lmi-approx");
    state.counts.approx++;
  }

  const delta = (ligaPrice / ref.brl - 1) * 100;
  const band = state.cfg.neutralBand;
  const cheaper = delta < -band;

  strip.title = [
    entry.approx
      ? `${entry.name} — preço do print ${entry.set?.toUpperCase()} #${entry.cn}` +
        (entry.wantedSet ? `, não de ${entry.wantedSet.toUpperCase()}` : "")
      : entry.name,
    `Liga: ${fmtBRL(ligaPrice)}`,
    // Os dois mercados, não só o escolhido: a diferença entre eles diz muito
    // sobre onde de fato vale comprar.
    ...opts.map(
      (o) =>
        `${o.label}: ${o.cur} ${o.raw.toFixed(2)} → ${fmtBRL(o.brl)}` +
        (opts.length > 1 && o === ref ? "   ← usado" : "")
    ),
    state.cfg.importFactor !== 1 ? `Fator de importação: ${state.cfg.importFactor}×` : null,
    foil ? "Comparando com preços foil" : null,
    cheaper ? "Mais barato na Liga" : delta > band ? "Mais barato lá fora" : "Praticamente empatado",
  ]
    .filter(Boolean)
    .join("\n");

  return strip;
}

/* ---------- resumo ---------- */

function summaryText() {
  const { total, cheaper, approx, missing } = state.counts;
  const marketLabel =
    state.cfg.market === "usd" ? "TCGplayer" : state.cfg.market === "eur" ? "Cardmarket" : "menor dos dois";

  const notes = [
    `${marketLabel} · USD ${state.fx.usd.toFixed(2)} · EUR ${state.fx.eur.toFixed(2)}`,
    state.cfg.importFactor !== 1 ? `fator ${state.cfg.importFactor}×` : null,
    approx ? `${approx} por nome` : null,
    missing ? `${missing} sem correspondência` : null,
  ].filter(Boolean);

  return (
    `<strong>${cheaper}</strong> de ${total} mais baratas na Liga` +
    `<span class="lmi-sub">${notes.join(" · ")}</span>`
  );
}

/** Prefere ficar dentro do cabeçalho da edição, junto do "295 cards". */
function summaryHost() {
  for (const el of document.querySelectorAll("div, span, td, p")) {
    const t = (el.textContent || "").trim();
    if (t.length > 120 || !/\d+\s*cards\b/i.test(t)) continue;
    if (el.querySelector(CARD_LINK)) continue;
    return el;
  }
  return null;
}

function renderSummary(html, isError) {
  let box = document.getElementById("lmi-summary");
  const host = summaryHost();

  if (!box) {
    box = document.createElement("div");
    box.id = "lmi-summary";
    if (host && host.parentElement) {
      box.classList.add("lmi-inline");
      host.parentElement.insertBefore(box, host.nextSibling);
    } else {
      box.classList.add("lmi-floating");
      document.body.appendChild(box);
    }
  }

  box.classList.toggle("lmi-error", !!isError);
  box.innerHTML = html;

  if (box.classList.contains("lmi-floating")) {
    const close = document.createElement("button");
    close.className = "lmi-close";
    close.textContent = "×";
    close.title = "Ocultar";
    close.addEventListener("click", () => box.remove());
    box.appendChild(close);
  }
}

/* ---------- página da carta individual ---------- */

/**
 * Na página da carta a âncora é a tabela "Preço Médio de Venda no Marketplace",
 * não o nome em inglês.
 *
 * Ancorar no nome só funciona quando ele é um subtítulo distinto, abaixo do nome
 * em português. Em carta sem nome em português (`aux=` vazio) o nome em inglês é
 * o próprio título e reaparece em vários pontos da página, então a busca pelo
 * primeiro nó com aquele texto cai em qualquer lugar — inclusive em nó oculto.
 * A tabela de preços é única na página e é o lugar semanticamente correto para
 * uma comparação de preço.
 */
/**
 * Na página da carta existe UMA carta, então um código de página é um código de
 * carta — o motivo que proibia varrer o DOM na listagem não se aplica aqui.
 *
 * Mesmo assim o padrão é apertado: só aceita texto do tipo "Rara (MKM)", um
 * rótulo curto terminando em parênteses. "Assassinato na Mansão Karlov (2024)"
 * cai fora pelo filtro de ano.
 */
function detailSetCode() {
  let best = null;
  for (const el of document.querySelectorAll("div, span, td, p, h3, h4")) {
    const text = (el.textContent || "").trim();
    if (text.length > 40) continue;
    const m = text.match(/^[^()]{2,30}\(([A-Z0-9]{2,6})\)$/);
    if (!m || isYear(m[1])) continue;
    if (!best || text.length < best.text.length) best = { code: m[1].toLowerCase(), text };
  }
  return best ? best.code : null;
}

function detailTargets() {
  let ligaPrice = null;

  // Não exigir que o rótulo seja folha: na Liga ele divide o container com o link
  // "Ver Mais". Pega o MENOR elemento que contém o texto — o mais próximo dele.
  let label = null;
  for (const el of document.querySelectorAll("div, span, h2, h3, h4, td, p")) {
    const text = el.textContent || "";
    if (!/Preço Médio de Venda/i.test(text)) continue;
    if (!label || text.length < (label.textContent || "").length) label = el;
  }
  let section = label?.parentElement || null;
  for (let i = 0; i < 5 && section; i++) {
    if (pricesIn(section).length >= 3) break;
    section = section.parentElement;
  }
  // A tabela traz duas linhas de três preços (menor · médio · maior): Normal e Foil.
  const found = pricesIn(section);
  const pick = (row) => (state.cfg.ligaAnchor === "max" ? Math.max(...row) : Math.min(...row));
  const rows = [];
  if (found.length >= 3) rows.push({ label: "Normal", foil: false, price: pick(found.slice(0, 3)) });
  if (found.length >= 6) rows.push({ label: "Foil", foil: true, price: pick(found.slice(3, 6)) });

  return { anchorEl: section, rows };
}

async function scanDetail() {
  if (document.querySelector(".lmi-detail")) return;

  const p = new URLSearchParams(location.search);
  const en = normalizeName(p.get("card"));
  const num = p.get("num");
  if (!en) return;

  const { anchorEl, rows } = detailTargets();
  if (!anchorEl || !anchorEl.parentElement || !rows.length) return;

  const set = pageSetCode() || detailSetCode();
  const card = { name: en, set: set || null, collector_number: set ? num : null };

  const res = await ask([card]);
  if (!res?.ok) return;
  state.fx = res.fx;

  const entry = res.prices[keyFor(card)];
  if (!entry || entry.missing) return;

  const checked = withAccuracy(entry, num);
  const block = document.createElement("div");
  block.className = "lmi-detail-block";
  for (const row of rows) {
    block.appendChild(buildStrip(checked, row.price, row.foil, "detail", row.label));
  }
  anchorEl.parentElement.insertBefore(block, anchorEl.nextSibling);
}

/* ---------- listagem ---------- */

async function scanListing() {
  const set = pageSetCode();
  const items = [];

  for (const [id, anchors] of groupAnchors()) {
    const tile = tileForGroup(id, anchors);
    if (!tile || tile.dataset.lmi || tile.querySelector(".lmi-strip")) continue;

    const prices = pricesIn(tile);
    if (!prices.length) continue;

    const info = parseCardHref(anchors[0].href);
    const sorted = [...prices].sort((a, b) => a - b);

    tile.dataset.lmi = "pending";
    items.push({
      tile,
      name: info.en,
      set: set || null,
      collector_number: set ? info.num : null,
      numHint: info.num,
      foil: /\bfoil\b/i.test(tile.textContent || ""),
      liga: state.cfg.ligaAnchor === "max" ? sorted[sorted.length - 1] : sorted[0],
    });
  }

  if (!items.length) return;

  const res = await ask(items.map(({ name, set, collector_number }) => ({ name, set, collector_number })));

  if (!res?.ok) {
    for (const it of items) delete it.tile.dataset.lmi; // permite nova tentativa
    renderSummary(`Falha ao buscar preços<span class="lmi-sub">${res?.error || "erro desconhecido"}</span>`, true);
    return;
  }

  state.fx = res.fx;

  for (const it of items) {
    it.tile.dataset.lmi = "done";
    const entry = res.prices[keyFor(it)];
    if (!entry || entry.missing) {
      state.counts.missing++;
      continue;
    }

    state.counts.total++;
    const strip = buildStrip(withAccuracy(entry, it.numHint), it.liga, it.foil);
    placeStrip(it.tile, strip);
  }

  renderSummary(summaryText());
}

/* ---------- infra ---------- */

async function ask(cards) {
  try {
    return await chrome.runtime.sendMessage({ type: "GET_PRICES", cards });
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function debounce(fn, ms) {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

const isDetailPage = () => /view=cards(%2F|\/)card\b/i.test(location.search);

(async function init() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  state.cfg = { ...DEFAULTS, ...stored };

  const scan = () => (isDetailPage() ? scanDetail() : scanListing());
  await scan();

  // A Liga carrega cards dinamicamente ao rolar e ao filtrar.
  new MutationObserver(debounce(scan, 400)).observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
