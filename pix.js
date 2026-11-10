/**
 * Pagamento nas páginas de pedido das lojas LigaMagic (?view=ecom/compra).
 *
 * As lojas rodam em domínios próprios (ex.: minhaloja.com.br), mas a página
 * de pedido é sempre a mesma plataforma. Como no content.js, nada de seletor
 * CSS da loja: ancora nos textos "Chave PIX:", "Valor Total: R$ x", "Conta:" etc.
 *
 * Coloca no topo do pedido um resumo com o valor total e os dados de pagamento
 * (com botões de copiar) e, havendo chave Pix, um BR Code estático (padrão EMV
 * do Banco Central) com chave + valor: QR e "copia e cola".
 */

(function () {
  const KEY_RE = /Chave\s*PIX\s*:?\s*([^\s]+)/i;
  const TOTAL_RE = /Valor\s+Total\s*:?\s*R\$\s*([\d.]{1,12},\d{2})/i;
  const ORDER_RE = /Pedido\s*#\s*(\d+)/i;
  // Campos "Rótulo: valor" em linha própria (âncora no começo da linha para
  // "Conta:" não pegar "Tipo de conta:").
  const line = (label) => new RegExp(`^[ \\t]*${label}[ \\t]*:[ \\t]*(.+)$`, "im");
  const HOLDER_RE = line("Titular");
  const BANK_RE = line("Banco");
  const BRANCH_RE = line("Ag[êe]ncia");
  const ACCOUNT_RE = line("Conta");

  /* ---------- BR Code ---------- */

  const field = (id, v) => id + String(v.length).padStart(2, "0") + v;

  function crc16(str) {
    let crc = 0xffff;
    for (const b of new TextEncoder().encode(str)) {
      crc ^= b << 8;
      for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc.toString(16).toUpperCase().padStart(4, "0");
  }

  const ascii = (s, max) =>
    (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 ]/g, "").trim().toUpperCase().slice(0, max);

  function normalizeKey(raw) {
    const k = raw.trim().replace(/[.,;]+$/, "");
    if (k.includes("@")) return k.toLowerCase();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return k.toLowerCase();
    if (k.startsWith("+")) return "+" + k.replace(/\D/g, "");
    return k.replace(/\D/g, ""); // CPF / CNPJ
  }

  function brCode({ key, amount, holder, txid }) {
    const p =
      field("00", "01") +
      field("26", field("00", "br.gov.bcb.pix") + field("01", key)) +
      field("52", "0000") +
      field("53", "986") +
      (amount ? field("54", amount) : "") +
      field("58", "BR") +
      field("59", ascii(holder, 25) || "RECEBEDOR") +
      field("60", "SAO PAULO") + // obrigatório no formato; o banco não usa
      field("62", field("05", (txid || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***")) +
      "6304";
    return p + crc16(p);
  }

  /* ---------- leitura da página ---------- */

  /**
   * Texto da página sem o nosso resumo: ele repete "Chave Pix", "Valor total"
   * etc. e, por vir antes dos dados da loja, contaminaria a releitura
   * (ex.: chave lida como "loja@gmail.comCopiar"). innerText ignora o que
   * está com display:none, e não há repintura entre esconder e mostrar.
   */
  function pageText() {
    const own = [...document.querySelectorAll(".lmi-pix-summary")];
    own.forEach((e) => (e.style.display = "none"));
    const text = document.body.innerText || "";
    own.forEach((e) => (e.style.display = ""));
    return text;
  }

  const grab = (text, re) => {
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };

  function readOrder() {
    const text = pageText();
    const key = grab(text, KEY_RE);
    const total = grab(text, TOTAL_RE);
    const account = grab(text, ACCOUNT_RE);
    // Sem total, ou sem nenhum dado de pagamento, não é a página que queremos.
    if (!total || !(key || account)) return null;
    const order = text.match(ORDER_RE) || location.search.match(/[?&]cod=(\d+)/);
    return {
      key: key ? normalizeKey(key) : null,
      amount: parseFloat(total.replace(/\./g, "").replace(",", ".")).toFixed(2),
      amountText: total, // como a loja escreve: "1.162,35"
      holder: grab(text, HOLDER_RE),
      bank: grab(text, BANK_RE),
      branch: grab(text, BRANCH_RE),
      account,
      order: order ? order[1] : null,
      txid: order ? "PEDIDO" + order[1] : "",
    };
  }

  /* ---------- itens e totais (para o e-mail) ---------- */

  const LANGS = "Inglês|Português|Japonês|Espanhol|Alemão|Francês|Italiano|Russo|Coreano|Chinês Simplificado|Chinês Tradicional|Chinês";
  const EDITION_RE = new RegExp(`^(.*?)\\s*(${LANGS})\\s*(?:[A-Z]{2})?\\s*(NM|SP|MP|HP|D|M)?\\s*$`);
  const RARITY_RE = /^\(\s*Rarid[a-z.]*\s*:\s*([A-Za-z])\b[^)]*\)\s*(.*)$/i;
  const RARITY = { C: "Comum", U: "Incomum", R: "Rara", M: "Mítica", S: "Especial", L: "Terreno básico", T: "Ficha" };
  const CONDITION = { M: "Mint", NM: "Near Mint", SP: "Slightly Played", MP: "Moderately Played", HP: "Heavily Played", D: "Damaged" };
  const ITEM_RE = /^(\d+)\s*x\s+(.+?)\s*\(C[óo]digo:\s*([^)]+)\)\s*$/i;
  const MONEY = /R\$\s*([\d.]{1,12},\d{2})/;
  const TOTAL_LINE_RE = /(Valor dos Itens|Desconto|Frete|Cr[ée]dito utilizado|Valor Total)\s*:\s*R\$\s*([\d.]{1,12},\d{2})/i;

  /** A loja escreve a edição duas vezes ("Doctor Who Doctor Who"). */
  function dedupeEdition(s) {
    s = s.trim();
    const n = s.length;
    if (n % 2 === 1 && s[(n - 1) / 2] === " " && s.slice(0, (n - 1) / 2) === s.slice((n + 1) / 2)) return s.slice(0, (n - 1) / 2);
    return s;
  }

  function readItems(text) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const items = [];
    let cur = null;
    for (const l of lines) {
      const m = l.match(ITEM_RE);
      if (m) {
        cur = { qty: +m[1], name: m[2], code: m[3].trim(), unit: null, subtotal: null, edition: null, rarity: null, lang: null, cond: null, foil: false };
        items.push(cur);
        continue;
      }
      if (!cur) continue;
      if (TOTAL_LINE_RE.test(l)) { cur = null; continue; }
      if (/\(unid\.?\)/i.test(l) && MONEY.test(l)) cur.unit = l.match(MONEY)[1];
      else if (/\(subtotal\)/i.test(l) && MONEY.test(l)) cur.subtotal = l.match(MONEY)[1];
      else if (/^Foil$/i.test(l)) cur.foil = true;
      else if (/^Cod:/i.test(l)) continue;
      else if (RARITY_RE.test(l)) {
        // Formato "(Rarid: U / Cor: W) Avatar: The Last Airbender" (ex.: Coliseu TCG)
        const r = l.match(RARITY_RE);
        cur.rarity = r[1].toUpperCase();
        if (r[2].trim()) cur.edition = r[2].trim();
      } else if (!cur.lang) {
        // "Doctor Who Doctor WhoInglês ENNM" (edição grudada) ou "Inglês EN NM" (linha própria)
        const e = l.match(EDITION_RE);
        if (e) {
          if (e[1].trim() && !cur.edition) cur.edition = dedupeEdition(e[1]);
          cur.lang = e[2];
          cur.cond = CONDITION[e[3]] || e[3] || null;
        }
      }
    }
    return items;
  }

  function readTotals(text) {
    const out = [];
    for (const l of text.split("\n")) {
      const m = l.match(TOTAL_LINE_RE);
      if (m && !out.some((t) => t.label.toLowerCase() === m[1].toLowerCase())) out.push({ label: m[1], value: m[2] });
    }
    return out;
  }

  /**
   * Link da carta na LigaMagic. A página aceita nome em inglês ou em
   * português. "A / B" é o nome nos dois idiomas (em qualquer ordem): fica a
   * primeira parte. "A // B" é carta dupla: vai inteiro, que é como a Liga indexa.
   */
  function ligaLink(name) {
    const n = name.split(/\s+\/\s+/)[0].trim(); // separa em " / ", não em " // "
    return "https://www.ligamagic.com.br/?view=cards/card&card=" + encodeURIComponent(n).replace(/%20/g, "+");
  }

  /**
   * Nome da loja: do rodapé ("Cartinhas Cards / CNPJ: ..."), que é o nome
   * comercial; o titular da conta pode ser outro. Sem rodapé, o domínio.
   */
  function storeName(text) {
    const m = [...text.matchAll(/^[ \t]*(.+?)[ \t]*\/[ \t]*CNPJ[ \t]*:/gim)].pop();
    return m ? m[1].trim() : location.hostname.replace(/^www\./, "");
  }

  const details = (i) => [i.edition, RARITY[i.rarity] || i.rarity, i.lang, i.cond, i.foil && "Foil"].filter(Boolean);

  /* ---------- símbolo da edição (imagens públicas da LigaMagic) ---------- */

  const ED_ICON = (ed, r) => `https://repositorio.sbrauble.com/arquivos/up/ed_mtg/${ed}_${r}.gif`;
  const probes = new Map();

  function imageExists(url) {
    if (!probes.has(url)) {
      probes.set(
        url,
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img.naturalWidth > 0);
          img.onerror = () => resolve(false);
          img.src = url;
          setTimeout(() => resolve(false), 4000);
        })
      );
    }
    return probes.get(url);
  }

  /**
   * O código da loja é edição + número ("TLA38", "DHHOB214"), mas a edição
   * pode terminar em dígito ("FBMH3" + "335"). Testa as divisões possíveis,
   * da edição mais longa para a mais curta, e fica com a primeira imagem que
   * existe. Só com a raridade informada: sem ela o símbolo sairia na cor errada.
   */
  async function editionIcon(item) {
    if (!item.rarity) return null;
    const code = item.code.replace(/\s.*$/, "").toUpperCase();
    const digits = (code.match(/\d+$/) || [""])[0];
    const urls = [];
    for (let k = 1; k <= digits.length; k++) {
      const ed = code.slice(0, code.length - k);
      if (/[A-Z]/.test(ed)) urls.push(ED_ICON(ed, item.rarity));
    }
    const ok = await Promise.all(urls.map(imageExists));
    return urls[ok.indexOf(true)] || null;
  }

  const withIcons = (items) => Promise.all(items.map(async (i) => (i.edIcon = await editionIcon(i)))).then(() => items);

  async function emailText(o) {
    const text = pageText();
    const items = await withIcons(readItems(text));
    const totals = readTotals(text);
    const store = storeName(text);
    const qty = items.reduce((s, i) => s + i.qty, 0);

    const subject = `[${store}] Pedido #${o.order || "?"} – ${fmtBRL(o.amount)}`;
    const L = [];
    L.push(`Pedido #${o.order || "?"} – ${store}`, location.href, "");
    if (items.length) {
      L.push(`${qty} ${qty === 1 ? "item" : "itens"}`, "");
      for (const i of items) {
        L.push(`${i.qty}x ${i.name} (${i.code})`);
        const det = details(i).join(" · ");
        const price = i.unit ? `R$ ${i.unit}${i.qty > 1 && i.subtotal ? ` un. = R$ ${i.subtotal}` : ""}` : "";
        L.push("   " + [det, price].filter(Boolean).join(" — "));
        L.push("   " + ligaLink(i.name));
      }
      L.push("");
    }
    for (const t of totals) L.push(`${t.label}: R$ ${t.value}`);
    if (!totals.length) L.push(`Valor Total: ${fmtBRL(o.amount)}`);
    L.push("", "PAGAMENTO");
    if (o.key) L.push(`Chave Pix: ${o.key}`);
    if (o.holder) L.push(`Titular: ${o.holder}`);
    const bankBits = [o.bank, o.branch && `Ag. ${o.branch}`, o.account && `Conta ${o.account}`].filter(Boolean);
    if (bankBits.length) L.push(`Banco: ${bankBits.join(" · ")}`);
    if (o.key) L.push("", "Pix copia e cola (valor já incluído):", brCode(o));
    return { subject, body: L.join("\n"), html: emailHtml(o, items, totals, store, qty) };
  }

  /* ---------- versão formatada (HTML, vai pela área de transferência) ---------- */

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  /**
   * Bloco de cada carta na página, na mesma ordem de readItems(): o maior
   * ancestral da linha "(Código: X)" que ainda contém só uma carta.
   */
  function itemBlocks() {
    const blocks = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/\(C[óo]digo:/i.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const count = (e) => ((e.innerText || e.textContent || "").match(/\(C[óo]digo:/gi) || []).length;
    for (let n; (n = walker.nextNode()); ) {
      let b = n.parentElement;
      while (b.parentElement && b.parentElement !== document.body && count(b.parentElement) <= 1) b = b.parentElement;
      blocks.push(b);
    }
    return blocks;
  }

  /**
   * Ícones da carta (edição, idioma, estado...): imagens pequenas e fundos de
   * imagem simples dentro do bloco. Imagens grandes (arte da carta) e sprites
   * (fundo com deslocamento, que sairia como a folha inteira) ficam de fora.
   */
  function iconsIn(block) {
    if (!block) return [];
    const out = [];
    const seen = new Set();
    const add = (src, alt) => {
      // data: o Gmail descarta; só endereços http(s) sobrevivem ao colar.
      if (!src || seen.has(src) || !/^https?:/.test(src)) return;
      seen.add(src);
      out.push({ src, alt: alt || "" });
    };
    for (const e of block.querySelectorAll("*")) {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height > 40 || r.width > 60) continue;
      if (e.tagName === "IMG") {
        add(e.currentSrc || e.src, e.alt || e.title);
        continue;
      }
      const cs = getComputedStyle(e);
      const m = cs.backgroundImage.match(/^url\("?(.+?)"?\)$/);
      if (m && /^(0(px|%)?\s*){1,2}$/.test(cs.backgroundPosition.trim())) add(m[1], e.title || e.getAttribute("aria-label"));
    }
    return out;
  }

  function emailHtml(o, items, totals, store, qty) {
    const blocks = itemBlocks();
    const font = "font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222";
    const small = "font-size:12px;color:#666";
    const td = "padding:6px 8px;border-bottom:1px solid #e5e5e5;vertical-align:top";
    const icon = (i) => `<img src="${esc(i.src)}" alt="${esc(i.alt)}" title="${esc(i.alt)}" height="14" style="height:14px;vertical-align:-2px;margin-right:3px">`;

    const H = [];
    H.push(`<div style="${font}">`);
    H.push(`<p style="font-size:16px;margin:0 0 12px">Pedido <a href="${esc(location.href)}"><b>#${esc(o.order || "?")}</b></a> – ${esc(store)}</p>`);

    if (items.length) {
      H.push(`<p style="margin:0 0 6px">${qty} ${qty === 1 ? "item" : "itens"}</p>`);
      H.push(`<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;${font}">`);
      items.forEach((i, k) => {
        const found = iconsIn(blocks[k]);
        // Loja que não mostra o símbolo da edição: usa o da própria LigaMagic.
        if (i.edIcon && !found.some((x) => /\/ed_mtg\//.test(x.src))) found.unshift({ src: i.edIcon, alt: i.edition || i.code });
        const icons = found.map(icon).join("");
        const det = details(i).map(esc).join(" · ");
        H.push(
          `<tr><td style="${td};white-space:nowrap"><b>${i.qty}x</b></td>` +
            `<td style="${td}"><a href="${esc(ligaLink(i.name))}">${esc(i.name)}</a> <span style="${small}">(${esc(i.code)})</span>` +
            `<br><span style="${small}">${icons}${det}</span></td>` +
            `<td style="${td};white-space:nowrap;text-align:right">${i.unit ? `R$ ${esc(i.unit)}` : ""}</td>` +
            `<td style="${td};white-space:nowrap;text-align:right"><b>${i.subtotal ? `R$ ${esc(i.subtotal)}` : ""}</b></td></tr>`
        );
      });
      H.push("</table>");
    }

    H.push(`<table cellpadding="0" cellspacing="0" style="margin-top:10px;${font}">`);
    const tl = totals.length ? totals : [{ label: "Valor Total", value: o.amountText }];
    for (const t of tl) {
      const strong = /total/i.test(t.label);
      H.push(`<tr><td style="padding:2px 12px 2px 0">${esc(t.label)}:</td><td style="padding:2px 0;text-align:right${strong ? ";font-weight:bold;font-size:16px" : ""}">R$ ${esc(t.value)}</td></tr>`);
    }
    H.push("</table>");

    H.push(`<p style="margin:16px 0 4px;font-weight:bold">Pagamento</p><p style="margin:0">`);
    const P = [];
    if (o.key) P.push(`Chave Pix: <b>${esc(o.key)}</b>`);
    if (o.holder) P.push(`Titular: ${esc(o.holder)}`);
    const bankBits = [o.bank, o.branch && `Ag. ${o.branch}`, o.account && `Conta ${o.account}`].filter(Boolean);
    if (bankBits.length) P.push(`Banco: ${esc(bankBits.join(" · "))}`);
    H.push(P.join("<br>") + "</p>");
    if (o.key) {
      H.push(`<p style="margin:10px 0 2px">Pix copia e cola (valor já incluído):</p>`);
      H.push(`<p style="margin:0;font-family:Consolas,monospace;font-size:12px;word-break:break-all">${esc(brCode(o))}</p>`);
      H.push(`<p style="margin:14px 0 6px">QR Code Pix (${esc(fmtBRL(o.amount))}):</p>`);
      H.push(qrTable(brCode(o)));
    }
    H.push("</div>");
    return H.join("\n");
  }

  /**
   * QR Code como tabela HTML (células pretas e brancas). O Gmail descarta
   * imagens data: ao colar, e gerar a imagem num serviço externo mandaria a
   * chave e o valor para terceiros; a tabela não depende de nada disso.
   * Células vizinhas da mesma cor viram uma só (colspan) e o markup é o mínimo
   * possível: o Gmail corta mensagens acima de ~102 KB.
   */
  function qrTable(payload, cell = 4, margin = 4) {
    const qr = qrcode(0, "M");
    qr.addData(payload, "Byte");
    qr.make();
    const n = qr.getModuleCount();
    const size = n + margin * 2;
    const dark = (r, c) => r >= margin && c >= margin && r < n + margin && c < n + margin && qr.isDark(r - margin, c - margin);
    const span = (k) => (k > 1 ? ` colspan="${k}"` : "");
    const rows = [];
    for (let r = 0; r < size; r++) {
      let html = "";
      for (let c = 0; c < size; ) {
        const d = dark(r, c);
        let k = 1;
        while (c + k < size && dark(r, c + k) === d) k++;
        html += d ? `<td${span(k)} bgcolor="#000" style="background:#000"></td>` : `<td${span(k)}></td>`;
        c += k;
      }
      rows.push(`<tr height="${cell}" style="height:${cell}px">${html}</tr>`);
    }
    // Primeira linha com uma célula por coluna fixa a grade (colspan sozinho não define larguras).
    const grid = `<tr height="0">${`<td width="${cell}" style="width:${cell}px"></td>`.repeat(size)}</tr>`;
    return (
      `<table cellpadding="0" cellspacing="0" border="0" width="${cell * size}" bgcolor="#fff" ` +
      `style="border-collapse:collapse;table-layout:fixed;width:${cell * size}px;background:#fff;font-size:0;line-height:0">` +
      grid + rows.join("") + "</table>"
    );
  }

  async function copyRich(html, text) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async function targetEmail() {
    let { orderEmail } = await chrome.storage.sync.get({ orderEmail: "" });
    if (orderEmail) return orderEmail;
    orderEmail = (prompt("Para qual e-mail devo mandar os resumos de pedido? (dá para mudar depois nas opções da extensão)") || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(orderEmail)) return null;
    await chrome.storage.sync.set({ orderEmail });
    return orderEmail;
  }

  const GMAIL_URL_MAX = 7000; // acima disso o Gmail pode recusar o link

  async function openGmail(o, btn) {
    const to = await targetEmail();
    if (!to) return;
    const { subject, body, html } = await emailText(o);
    // A versão formatada (links e ícones) vai para a área de transferência
    // antes de abrir a aba: depois disso a página perde o foco.
    const rich = await copyRich(html, body);
    const gmail = (b) =>
      "https://mail.google.com/mail/?view=cm&fs=1" +
      `&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(b)}`;
    let url = gmail(body);
    if (url.length > GMAIL_URL_MAX) {
      if (!rich) await copyText(body, btn, btn.textContent);
      url = gmail("(O pedido é grande demais para o link. O resumo completo foi copiado: apague esta linha e cole com Ctrl+V.)");
    }
    window.open(url, "_blank", "noopener");
    if (rich) flashHint(btn, "Versão com links e ícones copiada: no Gmail, apague o texto e cole com Ctrl+V.");
  }

  function flashHint(btn, text) {
    const old = btn.parentElement.querySelector(".lmi-pix-hint-flash");
    if (old) old.remove();
    const h = el("div", "lmi-pix-hint lmi-pix-hint-flash", text);
    btn.parentElement.after(h);
    setTimeout(() => h.remove(), 15000);
  }

  /** Menor elemento cujo texto casa com `re`. */
  function textAnchor(re) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (re.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const node = walker.nextNode();
    return node ? node.parentElement : null;
  }

  /**
   * Onde pôr o resumo: logo abaixo do número do pedido (topo da página).
   * Sem ele, logo antes dos dados de pagamento.
   */
  function summarySpot(o) {
    if (o.order) {
      const el = textAnchor(new RegExp(`#\\s*${o.order}\\b`));
      if (el && !el.closest("a, button")) return el;
    }
    return textAnchor(/Chave\s*PIX/i) || textAnchor(/^\s*Conta\s*:/i);
  }

  /* ---------- UI ---------- */

  const fmtBRL = (s) => Number(s).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  async function copyText(text, btn, label) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = el("textarea");
      t.value = text;
      document.body.append(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    btn.textContent = "Copiado!";
    setTimeout(() => (btn.textContent = label), 1500);
  }

  function copyButton(text, label = "Copiar") {
    const b = el("button", "lmi-pix-copy", label);
    b.type = "button";
    b.title = `Copiar: ${text}`;
    b.addEventListener("click", () => copyText(text, b, label));
    return b;
  }

  function row(label, value, copyValue) {
    const r = el("div", "lmi-pix-row");
    r.append(el("span", "lmi-pix-label", label), el("span", "lmi-pix-value", value));
    if (copyValue) r.append(copyButton(copyValue));
    return r;
  }

  function qrSvg(payload) {
    const qr = qrcode(0, "M");
    qr.addData(payload, "Byte");
    qr.make();
    return qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
  }

  function buildQrPanel(o) {
    const payload = brCode(o);
    const panel = el("div", "lmi-pix-panel");

    const qrBox = el("div", "lmi-pix-qr");
    qrBox.innerHTML = qrSvg(payload); // SVG gerado localmente, sem dado da página no markup

    const info = el("div", "lmi-pix-info");
    const code = el("textarea", "lmi-pix-code");
    code.readOnly = true;
    code.value = payload;
    code.addEventListener("focus", () => code.select());

    const copy = el("button", "lmi-pix-btn", "Copiar Pix copia e cola");
    copy.type = "button";
    copy.addEventListener("click", () => copyText(payload, copy, "Copiar Pix copia e cola"));

    info.append(
      el("div", "lmi-pix-hint", "Escaneie com o app do banco ou copie o código:"),
      code,
      copy,
      el("div", "lmi-pix-warn", "Antes de confirmar, confira no app do banco se o recebedor é a loja e se o valor está certo.")
    );
    panel.append(qrBox, info);
    return panel;
  }

  function buildSummary(o) {
    const box = el("div", "lmi-pix-summary");

    const head = el("div", "lmi-pix-head");
    const total = el("div", "lmi-pix-total");
    total.append(el("span", "lmi-pix-label", "Valor total"), el("span", "lmi-pix-amount", fmtBRL(o.amount)));
    total.append(copyButton(o.amountText, "Copiar valor"));
    head.append(total);
    box.append(head);

    if (o.key) box.append(row("Chave Pix", o.key, o.key));
    if (o.holder) box.append(row("Titular", o.holder));
    const bankBits = [o.bank, o.branch && `Ag. ${o.branch}`, o.account && `Conta ${o.account}`].filter(Boolean);
    if (bankBits.length) box.append(row("Banco", bankBits.join(" · "), o.account));

    const actions = el("div", "lmi-pix-actions");
    box.append(actions);

    const mail = el("button", "lmi-pix-btn lmi-pix-secondary", "Enviar por e-mail");
    mail.type = "button";
    mail.title = "Abre o Gmail com o resumo do pedido já preenchido";
    mail.addEventListener("click", () => openGmail(readOrder() || o, mail));

    if (o.key) {
      const toggle = el("button", "lmi-pix-btn lmi-pix-toggle", "Gerar QR Code Pix");
      toggle.type = "button";
      let panel = null;
      toggle.addEventListener("click", () => {
        if (panel) {
          panel.remove();
          panel = null;
          toggle.textContent = "Gerar QR Code Pix";
          return;
        }
        panel = buildQrPanel(readOrder() || o); // relê, caso a página tenha mudado
        box.append(panel);
        toggle.textContent = "Fechar QR Code";
      });
      actions.append(toggle);
    }
    actions.append(mail);
    return box;
  }

  function install() {
    if (document.querySelector(".lmi-pix-summary")) return true;
    const order = readOrder();
    if (!order) return false;
    const spot = summarySpot(order);
    if (!spot) return false;
    spot.after(buildSummary(order));
    // Já testa os símbolos de edição, para o clique em "Enviar por e-mail" não esperar a rede.
    withIcons(readItems(pageText()));
    return true;
  }

  if (!install()) {
    // Página montada depois do carregamento: tenta mais algumas vezes.
    const obs = new MutationObserver(() => install() && obs.disconnect());
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 15000);
  }
})();
