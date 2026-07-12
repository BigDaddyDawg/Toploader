/**
 * Live card-show sync via Supabase.
 * Marks cards "got it" so everyone on the wishlist sees updates in seconds.
 */
(function () {
  const BUYER_NAME_KEY = "toploader_buyer_name_v1";
  const HIDE_BOUGHT_KEY = "toploader_hide_bought_v1";

  let client = null;
  let showDate = "";
  let boughtMap = new Map();
  let ready = false;
  let live = false;
  let channel = null;
  let onChangeCb = null;

  function config() {
    return window.TOPLOADER_SUPABASE || {};
  }

  function isConfigured() {
    const cfg = config();
    return Boolean((cfg.url || "").trim() && (cfg.anonKey || "").trim());
  }

  function cardKey(card) {
    return String(card?.card_key || "").trim();
  }

  function loadHideBought() {
    try {
      const raw = localStorage.getItem(HIDE_BOUGHT_KEY);
      return raw === null ? true : raw === "1";
    } catch (_) {
      return true;
    }
  }

  function saveHideBought(value) {
    try {
      localStorage.setItem(HIDE_BOUGHT_KEY, value ? "1" : "0");
    } catch (_) {}
  }

  function buyerName() {
    try {
      return (localStorage.getItem(BUYER_NAME_KEY) || "").trim();
    } catch (_) {
      return "";
    }
  }

  function saveBuyerName(name) {
    try {
      localStorage.setItem(BUYER_NAME_KEY, (name || "").trim());
    } catch (_) {}
  }

  function promptBuyerName() {
    const existing = buyerName();
    const name = window.prompt(
      "Your name (so everyone knows who got the card):",
      existing || ""
    );
    if (name === null) return "";
    const trimmed = name.trim();
    if (trimmed) saveBuyerName(trimmed);
    return trimmed;
  }

  function ingestRows(rows) {
    boughtMap = new Map();
    (rows || []).forEach(row => {
      const key = String(row.card_key || "").trim();
      if (!key) return;
      boughtMap.set(key, {
        bought_by: String(row.bought_by || "").trim(),
        bought_at: row.bought_at || "",
      });
    });
  }

  function notifyChange() {
    if (typeof onChangeCb === "function") onChangeCb();
  }

  async function fetchBought() {
    if (!client || !showDate) return;
    const { data, error } = await client
      .from("show_bought_cards")
      .select("card_key,bought_by,bought_at")
      .eq("show_date", showDate);
    if (error) throw error;
    ingestRows(data);
    notifyChange();
  }

  function subscribe() {
    if (!client || !showDate || channel) return;
    channel = client
      .channel(`show-bought-${showDate}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "show_bought_cards",
          filter: `show_date=eq.${showDate}`,
        },
        () => {
          fetchBought().catch(() => {});
        }
      )
      .subscribe(status => {
        live = status === "SUBSCRIBED";
        notifyChange();
      });
  }

  async function init(snapshot) {
    ready = false;
    live = false;
    showDate = String(snapshot?.local_date || "").trim();
    boughtMap = new Map();
    if (channel) {
      client?.removeChannel(channel);
      channel = null;
    }

    if (!isConfigured() || !showDate) {
      notifyChange();
      return false;
    }

    if (!window.supabase?.createClient) {
      console.warn("Supabase JS not loaded");
      notifyChange();
      return false;
    }

    const cfg = config();
    client = window.supabase.createClient(cfg.url.trim(), cfg.anonKey.trim());
    try {
      await fetchBought();
      subscribe();
      ready = true;
      notifyChange();
      return true;
    } catch (err) {
      console.warn("Show sync init failed:", err);
      notifyChange();
      return false;
    }
  }

  function isBought(card) {
    const key = cardKey(card);
    return key ? boughtMap.has(key) : false;
  }

  function boughtInfo(card) {
    return boughtMap.get(cardKey(card)) || null;
  }

  function hideBought() {
    return loadHideBought();
  }

  function setHideBought(value) {
    saveHideBought(Boolean(value));
    notifyChange();
  }

  function filterCards(cards) {
    if (!hideBought()) return cards.slice();
    return cards.filter(card => !isBought(card));
  }

  function boughtCount(cards) {
    return (cards || []).filter(isBought).length;
  }

  function statusText(snapshot) {
    if (!isConfigured()) return "";
    if (!showDate) return "Live sync needs snapshot date";
    if (!ready) return "Connecting live sync…";
    const got = boughtMap.size;
    const liveBit = live ? "Live" : "Polling";
    return got ? `${liveBit} · ${got} got` : `${liveBit} · synced`;
  }

  function statusClass() {
    if (!isConfigured() || !ready) return "sync-off";
    return live ? "sync-live" : "sync-warn";
  }

  async function markBought(card) {
    if (!client || !showDate) return { ok: false, error: "Sync not ready" };
    const key = cardKey(card);
    if (!key) return { ok: false, error: "Missing card key" };

    let name = buyerName();
    if (!name) {
      name = promptBuyerName();
      if (!name) return { ok: false, error: "Name required" };
    }

    const row = {
      show_date: showDate,
      card_key: key,
      bought_by: name,
      bought_at: new Date().toISOString(),
    };

    const { error } = await client
      .from("show_bought_cards")
      .upsert(row, { onConflict: "show_date,card_key" });
    if (error) return { ok: false, error: error.message };

    boughtMap.set(key, { bought_by: name, bought_at: row.bought_at });
    notifyChange();
    return { ok: true };
  }

  async function unmarkBought(card) {
    if (!client || !showDate) return { ok: false, error: "Sync not ready" };
    const key = cardKey(card);
    if (!key) return { ok: false, error: "Missing card key" };

    const { error } = await client
      .from("show_bought_cards")
      .delete()
      .eq("show_date", showDate)
      .eq("card_key", key);
    if (error) return { ok: false, error: error.message };

    boughtMap.delete(key);
    notifyChange();
    return { ok: true };
  }

  function wireListActions(listEl) {
    if (!listEl || !isConfigured()) return;
    listEl.querySelectorAll("[data-got-it]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.gotIt || "";
        const card = { card_key: key };
        btn.disabled = true;
        const result = await markBought(card);
        btn.disabled = false;
        if (!result.ok && result.error) {
          window.alert(result.error);
        }
      });
    });
    listEl.querySelectorAll("[data-undo-got]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.undoGot || "";
        const card = { card_key: key };
        btn.disabled = true;
        const result = await unmarkBought(card);
        btn.disabled = false;
        if (!result.ok && result.error) {
          window.alert(result.error);
        }
      });
    });
  }

  function renderGotItControls(card, escapeHtml) {
    if (!isConfigured() || !ready) return "";
    const key = cardKey(card);
    if (!key) return "";

    const info = boughtInfo(card);
    if (info) {
      const who = info.bought_by ? escapeHtml(info.bought_by) : "Someone";
      return `
        <div class="got-it-row">
          <span class="badge got-badge">Got it · ${who}</span>
          <button type="button" class="undo-got-btn" data-undo-got="${escapeHtml(key)}">Undo</button>
        </div>
      `;
    }

    return `
      <div class="got-it-row">
        <button type="button" class="got-it-btn" data-got-it="${escapeHtml(key)}">Got it ✓</button>
      </div>
    `;
  }

  function cardExtraClass(card) {
    return isBought(card) ? "card-bought" : "";
  }

  window.showSync = {
    init,
    isConfigured,
    isBought,
    boughtInfo,
    hideBought,
    setHideBought,
    filterCards,
    boughtCount,
    statusText,
    statusClass,
    markBought,
    unmarkBought,
    wireListActions,
    renderGotItControls,
    cardExtraClass,
    onChange(cb) {
      onChangeCb = cb;
    },
  };
})();
