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

  const grab = (text, re) => {
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };

  function readOrder() {
    const text = document.body.innerText || "";
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
      box.append(toggle);
    }
    return box;
  }

  function install() {
    if (document.querySelector(".lmi-pix-summary")) return true;
    const order = readOrder();
    if (!order) return false;
    const spot = summarySpot(order);
    if (!spot) return false;
    spot.after(buildSummary(order));
    return true;
  }

  if (!install()) {
    // Página montada depois do carregamento: tenta mais algumas vezes.
    const obs = new MutationObserver(() => install() && obs.disconnect());
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 15000);
  }
})();
