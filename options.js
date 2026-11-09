const DEFAULTS = {
  market: "min",
  importFactor: 1.0,
  ligaAnchor: "min",
  neutralBand: 5,
};

const els = {
  market: document.getElementById("market"),
  importFactor: document.getElementById("importFactor"),
  ligaAnchor: document.getElementById("ligaAnchor"),
  neutralBand: document.getElementById("neutralBand"),
  status: document.getElementById("status"),
};

function flash(text) {
  els.status.textContent = text;
  setTimeout(() => (els.status.textContent = ""), 2000);
}

(async function load() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  els.market.value = cfg.market;
  els.importFactor.value = cfg.importFactor;
  els.ligaAnchor.value = cfg.ligaAnchor;
  els.neutralBand.value = cfg.neutralBand;
})();

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.sync.set({
    market: els.market.value,
    importFactor: parseFloat(els.importFactor.value) || 1,
    ligaAnchor: els.ligaAnchor.value,
    neutralBand: parseInt(els.neutralBand.value, 10) || 0,
  });
  flash("Salvo. Recarregue a página da Liga.");
});

document.getElementById("clear").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "CLEAR_CACHE" });
  flash(res?.ok ? `${res.removed} itens removidos.` : "Falha ao limpar.");
});
