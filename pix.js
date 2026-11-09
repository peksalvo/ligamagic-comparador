/**
 * Pix nas páginas de pedido das lojas LigaMagic (?view=ecom/compra).
 *
 * As lojas rodam em domínios próprios (ex.: minhaloja.com.br), mas a
 * página de pedido é sempre a mesma plataforma. Como no content.js, nada de
 * seletor CSS da loja: ancora no texto "Chave PIX:" e em "Valor Total: R$ x".
 *
 * Gera um BR Code estático (padrão EMV do Banco Central) com chave + valor e
 * mostra o QR e o "copia e cola" num painel logo abaixo da chave.
 */

(function () {
  const KEY_RE = /Chave\s*PIX\s*:?\s*([^\s]+)/i;
  const TOTAL_RE = /Valor\s+Total\s*:?\s*R\$\s*([\d.]{1,12},\d{2})/i;
  const HOLDER_RE = /Titular\s*:?\s*([^\n\r]+)/i;
  const ORDER_RE = /Pedido\s*#\s*(\d+)/i;

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

  function brCode({ key, amount, name, txid }) {
    const p =
      field("00", "01") +
      field("26", field("00", "br.gov.bcb.pix") + field("01", key)) +
      field("52", "0000") +
      field("53", "986") +
      (amount ? field("54", amount) : "") +
      field("58", "BR") +
      field("59", ascii(name, 25) || "RECEBEDOR") +
      field("60", "SAO PAULO") + // obrigatório no formato; o banco não usa
      field("62", field("05", (txid || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***")) +
      "6304";
    return p + crc16(p);
  }

  /* ---------- leitura da página ---------- */

  function readOrder() {
    const text = document.body.innerText || "";
    const key = text.match(KEY_RE);
    if (!key) return null;
    const total = text.match(TOTAL_RE);
    const holder = text.match(HOLDER_RE);
    const order = text.match(ORDER_RE) || location.search.match(/[?&]cod=(\d+)/);
    return {
      key: normalizeKey(key[1]),
      amount: total ? parseFloat(total[1].replace(/\./g, "").replace(",", ".")).toFixed(2) : null,
      name: holder ? holder[1].trim() : document.location.hostname.replace(/^www\./, "").split(".")[0],
      txid: order ? "PEDIDO" + order[1] : "",
    };
  }

  /** Elemento que contém o texto "Chave PIX" (o menor possível). */
  function keyAnchor() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/Chave\s*PIX/i.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const node = walker.nextNode();
    return node ? node.parentElement : null;
  }

  /* ---------- UI ---------- */

  const fmtBRL = (s) => Number(s).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  function qrSvg(payload) {
    const qr = qrcode(0, "M");
    qr.addData(payload, "Byte");
    qr.make();
    return qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
  }

  function buildPanel(o) {
    const payload = brCode(o);
    const panel = document.createElement("div");
    panel.className = "lmi-pix-panel";

    const qrBox = document.createElement("div");
    qrBox.className = "lmi-pix-qr";
    qrBox.innerHTML = qrSvg(payload); // SVG gerado localmente, sem dado da página no markup

    const info = document.createElement("div");
    info.className = "lmi-pix-info";

    const amount = document.createElement("div");
    amount.className = "lmi-pix-amount";
    amount.textContent = o.amount ? fmtBRL(o.amount) : "Valor não encontrado: digite no app";

    const meta = document.createElement("div");
    meta.className = "lmi-pix-meta";
    meta.textContent = `Chave: ${o.key}` + (o.txid ? ` · ${o.txid}` : "");

    const code = document.createElement("textarea");
    code.className = "lmi-pix-code";
    code.readOnly = true;
    code.value = payload;
    code.addEventListener("focus", () => code.select());

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "lmi-pix-btn";
    copy.textContent = "Copiar Pix copia e cola";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(payload);
      } catch {
        code.select();
        document.execCommand("copy");
      }
      copy.textContent = "Copiado!";
      setTimeout(() => (copy.textContent = "Copiar Pix copia e cola"), 1500);
    });

    const warn = document.createElement("div");
    warn.className = "lmi-pix-warn";
    warn.textContent = "Antes de confirmar, confira no app do banco se o recebedor é a loja e se o valor está certo.";

    info.append(amount, meta, code, copy, warn);
    panel.append(qrBox, info);
    return panel;
  }

  function install() {
    if (document.querySelector(".lmi-pix-toggle")) return true;
    const anchor = keyAnchor();
    const order = anchor && readOrder();
    if (!order) return false;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "lmi-pix-btn lmi-pix-toggle";
    toggle.textContent = "Gerar QR Code Pix" + (order.amount ? ` (${fmtBRL(order.amount)})` : "");

    let panel = null;
    toggle.addEventListener("click", () => {
      if (panel) {
        panel.remove();
        panel = null;
        return;
      }
      panel = buildPanel(readOrder() || order); // relê, caso a página tenha mudado
      toggle.after(panel);
    });

    anchor.after(toggle);
    return true;
  }

  if (!install()) {
    // Página montada depois do carregamento: tenta mais algumas vezes.
    const obs = new MutationObserver(() => install() && obs.disconnect());
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 15000);
  }
})();
