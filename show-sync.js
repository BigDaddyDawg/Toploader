/**
 * Live card-show sync via Supabase.
 *
 * Tapping "Purchased" on a wishlist card moves it to the shared, permanent
 * Owned list and removes it from everyone's wishlist within seconds. Unlike the
 * old per-show "Got it" marks, ownership is keyed by card_key and never resets.
 */
(function () {
  const BUYER_NAME_KEY = "toploader_buyer_name_v1";
  // Kept the v1 key so existing phones keep their "hide" preference.
  const HIDE_OWNED_KEY = "toploader_hide_bought_v1";

  let client = null;
  let showDate = "";
  let ownedMap = new Map(); // card_key -> owned record (with metadata)
  let cardIndex = new Map(); // card_key -> full card object from latest snapshot
  let ready = false;
  let live = false;
  let channel = null;
  let onChangeCb = null;

  function config() {
    return window.TOPLOADER_SUPABASE || {};
  }

  function ownedTable() {
    return (config().table || "toploader_owned_cards").trim();
  }

  function isConfigured() {
    const cfg = config();
    return Boolean((cfg.url || "").trim() && (cfg.anonKey || "").trim());
  }

  function cardKey(card) {
    return String(card?.card_key || "").trim();
  }

  function numOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function loadHideOwned() {
    try {
      const raw = localStorage.getItem(HIDE_OWNED_KEY);
      return raw === null ? true : raw === "1";
    } catch (_) {
      return true;
    }
  }

  function saveHideOwned(value) {
    try {
      localStorage.setItem(HIDE_OWNED_KEY, value ? "1" : "0");
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
      "Your name (so everyone knows who bought the card):",
      existing || ""
    );
    if (name === null) return "";
    const trimmed = name.trim();
    if (trimmed) saveBuyerName(trimmed);
    return trimmed;
  }

  function ingestRows(rows) {
    ownedMap = new Map();
    (rows || []).forEach(row => {
      const key = String(row.card_key || "").trim();
      if (!key) return;
      ownedMap.set(key, {
        card_key: key,
        card: String(row.card_name || "").trim(),
        number: String(row.number || "").trim(),
        set_name: String(row.set_name || "").trim(),
        image_small_url: String(row.image_small_url || "").trim(),
        image_large_url: String(row.image_large_url || "").trim(),
        target_buy_gbp: numOrNull(row.target_buy_gbp),
        floor_gbp: numOrNull(row.floor_gbp),
        bought_by: String(row.bought_by || "").trim(),
        bought_price_gbp: numOrNull(row.bought_price_gbp),
        bought_at: row.bought_at || "",
      });
    });
  }

  function notifyChange() {
    if (typeof onChangeCb === "function") onChangeCb();
  }

  async function fetchOwned() {
    if (!client) return;
    const { data, error } = await client
      .from(ownedTable())
      .select(
        "card_key,card_name,number,set_name,image_small_url,image_large_url,target_buy_gbp,floor_gbp,bought_by,bought_price_gbp,bought_at"
      );
    if (error) throw error;
    ingestRows(data);
    notifyChange();
  }

  function subscribe() {
    if (!client || channel) return;
    channel = client
      .channel("owned-cards")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: ownedTable() },
        () => {
          fetchOwned().catch(() => {});
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
    ownedMap = new Map();
    cardIndex = new Map();
    (snapshot?.cards || []).forEach(card => {
      const key = cardKey(card);
      if (key) cardIndex.set(key, card);
    });
    if (channel) {
      client?.removeChannel(channel);
      channel = null;
    }

    if (!isConfigured()) {
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
      await fetchOwned();
      subscribe();
      ready = true;
      notifyChange();
      return true;
    } catch (err) {
      console.warn("Owned sync init failed:", err);
      notifyChange();
      return false;
    }
  }

  function isOwned(card) {
    const key = cardKey(card);
    return key ? ownedMap.has(key) : false;
  }

  function ownedInfo(card) {
    return ownedMap.get(cardKey(card)) || null;
  }

  function ownedList() {
    return Array.from(ownedMap.values()).sort((a, b) =>
      String(b.bought_at || "").localeCompare(String(a.bought_at || ""))
    );
  }

  function hideOwned() {
    return loadHideOwned();
  }

  function setHideOwned(value) {
    saveHideOwned(Boolean(value));
    notifyChange();
  }

  function filterCards(cards) {
    if (!hideOwned()) return cards.slice();
    return cards.filter(card => !isOwned(card));
  }

  function ownedCount(cards) {
    return (cards || []).filter(isOwned).length;
  }

  function statusText() {
    if (!isConfigured()) return "";
    if (!ready) return "Connecting live sync…";
    const owned = ownedMap.size;
    const liveBit = live ? "Live" : "Polling";
    return owned ? `${liveBit} · ${owned} owned` : `${liveBit} · synced`;
  }

  function statusClass() {
    if (!isConfigured() || !ready) return "sync-off";
    return live ? "sync-live" : "sync-warn";
  }

  async function markPurchased(card) {
    if (!client) return { ok: false, error: "Sync not ready" };
    const key = cardKey(card);
    if (!key) return { ok: false, error: "Missing card key" };

    let name = buyerName();
    if (!name) {
      name = promptBuyerName();
      if (!name) return { ok: false, error: "Name required" };
    }

    // Prefer richer metadata from the current snapshot so the Owned list still
    // renders after the card drops off future floors.json exports.
    const meta = cardIndex.get(key) || card || {};
    const row = {
      card_key: key,
      card_name: String(meta.card || card.card || "").slice(0, 200),
      number: String(meta.number || card.number || "").slice(0, 40),
      set_name: String(meta.set_name || card.set_name || "").slice(0, 200),
      image_small_url: String(meta.image_small_url || card.image_small_url || ""),
      image_large_url: String(meta.image_large_url || card.image_large_url || ""),
      target_buy_gbp: numOrNull(meta.target_buy_gbp),
      floor_gbp: numOrNull(meta.floor_gbp),
      bought_by: name,
      bought_at: new Date().toISOString(),
    };

    const { error } = await client
      .from(ownedTable())
      .upsert(row, { onConflict: "card_key" });
    if (error) return { ok: false, error: error.message };

    ownedMap.set(key, { ...row, card: row.card_name, bought_price_gbp: null });
    notifyChange();
    return { ok: true };
  }

  async function unmarkPurchased(card) {
    if (!client) return { ok: false, error: "Sync not ready" };
    const key = cardKey(card);
    if (!key) return { ok: false, error: "Missing card key" };

    const { error } = await client
      .from(ownedTable())
      .delete()
      .eq("card_key", key);
    if (error) return { ok: false, error: error.message };

    ownedMap.delete(key);
    notifyChange();
    return { ok: true };
  }

  function wireListActions(listEl) {
    if (!listEl || !isConfigured()) return;
    listEl.querySelectorAll("[data-purchase]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.purchase || "";
        btn.disabled = true;
        const result = await markPurchased({ card_key: key });
        btn.disabled = false;
        if (!result.ok && result.error) {
          window.alert(result.error);
        }
      });
    });
    listEl.querySelectorAll("[data-unpurchase]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.unpurchase || "";
        btn.disabled = true;
        const result = await unmarkPurchased({ card_key: key });
        btn.disabled = false;
        if (!result.ok && result.error) {
          window.alert(result.error);
        }
      });
    });
  }

  function renderPurchaseControls(card, escapeHtml) {
    if (!isConfigured()) return "";
    const key = cardKey(card);
    if (!key) return "";

    const info = ownedInfo(card);
    if (info) {
      const who = info.bought_by ? escapeHtml(info.bought_by) : "Someone";
      return `
        <div class="got-it-row">
          <span class="badge got-badge">Owned · ${who}</span>
          <button type="button" class="undo-got-btn" data-unpurchase="${escapeHtml(key)}">Undo</button>
        </div>
      `;
    }

    if (!ready) {
      return `
        <div class="got-it-row">
          <button type="button" class="got-it-btn" disabled>Purchased ✓ (connecting…)</button>
        </div>
      `;
    }

    return `
      <div class="got-it-row">
        <button type="button" class="got-it-btn" data-purchase="${escapeHtml(key)}">Purchased ✓</button>
      </div>
    `;
  }

  function cardExtraClass(card) {
    // Reuse existing ".card-bought" styling for owned cards.
    return isOwned(card) ? "card-bought" : "";
  }

  window.showSync = {
    init,
    isConfigured,
    isOwned,
    ownedInfo,
    ownedList,
    hideOwned,
    setHideOwned,
    filterCards,
    ownedCount,
    statusText,
    statusClass,
    isReady: () => ready,
    markPurchased,
    unmarkPurchased,
    wireListActions,
    renderPurchaseControls,
    cardExtraClass,
    onChange(cb) {
      onChangeCb = cb;
    },
    // Backwards-compatible aliases for older markup / callers.
    isBought: isOwned,
    boughtInfo: ownedInfo,
    hideBought: hideOwned,
    setHideBought: setHideOwned,
    boughtCount: ownedCount,
    markBought: markPurchased,
    unmarkBought: unmarkPurchased,
    renderGotItControls: renderPurchaseControls,
  };
})();
