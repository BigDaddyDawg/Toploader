/**
 * Live Toploader sync via Supabase (panelbook).
 *
 * Wishlist + purchased state live in:
 *   toploader_wishlist_cards
 *   toploader_owned_cards
 *
 * Purchased removes a card from the wishlist so it disappears from the phone app.
 */
(function () {
  const BUYER_NAME_KEY = "toploader_buyer_name_v1";
  const HIDE_OWNED_KEY = "toploader_hide_bought_v1";

  let client = null;
  let showDate = "";
  let ownedMap = new Map();
  let wishlistMap = new Map();
  let cardIndex = new Map();
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

  function makeCardKey(name, number, setName) {
    return [
      String(name || "").trim().toLowerCase(),
      String(number || "").trim(),
      String(setName || "").trim().toLowerCase(),
    ].join("|");
  }

  function numOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function loadHideOwned() {
    // Owned cards always drop off the active lists; preference kept for older callers.
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

  function ingestOwnedRows(rows) {
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

  function ingestWishlistRows(rows) {
    wishlistMap = new Map();
    (rows || []).forEach(row => {
      const key = String(row.card_key || "").trim();
      if (!key) return;
      wishlistMap.set(key, {
        card_key: key,
        card_name: String(row.card_name || "").trim(),
        card: String(row.card_name || "").trim(),
        number: String(row.number || "").trim(),
        set_name: String(row.set_name || "").trim(),
        scrape_query: String(row.scrape_query || "").trim(),
        rarity: String(row.rarity || "").trim(),
        image_small_url: String(row.image_small_url || "").trim(),
        image_large_url: String(row.image_large_url || "").trim(),
        target_buy_gbp: numOrNull(row.target_buy_gbp),
        floor_gbp: numOrNull(row.floor_gbp),
        added_by: String(row.added_by || "").trim(),
        added_at: row.added_at || "",
        watchlist_status: 1,
      });
    });
  }

  function notifyChange() {
    if (typeof onChangeCb === "function") onChangeCb();
  }

  async function fetchOwned() {
    if (!client) return;
    const { data, error } = await client
      .from("toploader_owned_cards")
      .select(
        "card_key,card_name,number,set_name,image_small_url,image_large_url,target_buy_gbp,floor_gbp,bought_by,bought_price_gbp,bought_at"
      );
    if (error) throw error;
    ingestOwnedRows(data);
  }

  async function fetchWishlist() {
    if (!client) return;
    const { data, error } = await client
      .from("toploader_wishlist_cards")
      .select(
        "card_key,card_name,number,set_name,scrape_query,rarity,image_small_url,image_large_url,target_buy_gbp,floor_gbp,added_by,added_at"
      )
      .order("added_at", { ascending: false });
    if (error) throw error;
    ingestWishlistRows(data);
  }

  async function refreshAll() {
    await Promise.all([fetchOwned(), fetchWishlist()]);
    notifyChange();
  }

  function subscribe() {
    if (!client || channel) return;
    channel = client
      .channel("toploader-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "toploader_owned_cards" },
        () => {
          refreshAll().catch(() => {});
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "toploader_wishlist_cards" },
        () => {
          refreshAll().catch(() => {});
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
    wishlistMap = new Map();
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
      await refreshAll();
      subscribe();
      ready = true;
      notifyChange();
      return true;
    } catch (err) {
      console.warn("Toploader sync init failed:", err);
      notifyChange();
      return false;
    }
  }

  function isOwned(card) {
    const key = cardKey(card);
    return key ? ownedMap.has(key) : false;
  }

  function isWishlisted(card) {
    const key = cardKey(card);
    return key ? wishlistMap.has(key) && !ownedMap.has(key) : false;
  }

  function ownedInfo(card) {
    return ownedMap.get(cardKey(card)) || null;
  }

  function ownedList() {
    return Array.from(ownedMap.values()).sort((a, b) =>
      String(b.bought_at || "").localeCompare(String(a.bought_at || ""))
    );
  }

  function wishlistList() {
    return Array.from(wishlistMap.values())
      .filter(row => !ownedMap.has(row.card_key))
      .sort((a, b) => String(b.added_at || "").localeCompare(String(a.added_at || "")));
  }

  function hideOwned() {
    return true; // purchased cards always leave active lists
  }

  function setHideOwned(value) {
    saveHideOwned(Boolean(value));
    notifyChange();
  }

  function filterCards(cards) {
    return (cards || []).filter(card => !isOwned(card));
  }

  function ownedCount(cards) {
    return (cards || []).filter(isOwned).length;
  }

  function statusText() {
    if (!isConfigured()) return "";
    if (!ready) return "Connecting live sync…";
    const wish = wishlistMap.size;
    const liveBit = live ? "Live" : "Polling";
    return wish ? `${liveBit} · ${wish} wishlist` : `${liveBit} · synced`;
  }

  function statusClass() {
    if (!isConfigured() || !ready) return "sync-off";
    return live ? "sync-live" : "sync-warn";
  }

  async function addWishlistCards(cards, addedBy = "") {
    if (!client) return { ok: false, error: "Sync not ready" };
    const rows = (cards || [])
      .map(card => {
        const name = String(card.card_name || card.card || card.name || "").trim();
        const number = String(card.number || "").trim();
        const setName = String(card.set_name || "").trim();
        const key = String(card.card_key || makeCardKey(name, number, setName)).trim();
        if (!key || !name || !number || !setName) return null;
        const scrape =
          String(card.scrape_query || "").trim() ||
          [name, setName, number].filter(Boolean).join(" ");
        return {
          card_key: key,
          card_name: name.slice(0, 200),
          number: number.slice(0, 40),
          set_name: setName.slice(0, 200),
          scrape_query: scrape.slice(0, 400),
          rarity: String(card.rarity || "").slice(0, 80),
          image_small_url: String(card.image_small_url || ""),
          image_large_url: String(card.image_large_url || ""),
          target_buy_gbp: numOrNull(card.target_buy_gbp),
          floor_gbp: numOrNull(card.floor_gbp),
          added_by: String(addedBy || buyerName() || "").slice(0, 80),
          updated_at: new Date().toISOString(),
        };
      })
      .filter(Boolean);

    if (!rows.length) return { ok: false, error: "No valid cards to add" };

    const { error } = await client
      .from("toploader_wishlist_cards")
      .upsert(rows, { onConflict: "card_key" });
    if (error) return { ok: false, error: error.message };

    rows.forEach(row => {
      wishlistMap.set(row.card_key, {
        ...row,
        card: row.card_name,
        watchlist_status: 1,
        added_at: row.updated_at,
      });
    });
    notifyChange();
    return { ok: true, count: rows.length };
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

    const meta = cardIndex.get(key) || wishlistMap.get(key) || card || {};
    const row = {
      card_key: key,
      card_name: String(meta.card || meta.card_name || card.card || "").slice(0, 200),
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
      .from("toploader_owned_cards")
      .upsert(row, { onConflict: "card_key" });
    if (error) return { ok: false, error: error.message };

    await client.from("toploader_wishlist_cards").delete().eq("card_key", key);

    ownedMap.set(key, { ...row, card: row.card_name, bought_price_gbp: null });
    wishlistMap.delete(key);
    notifyChange();
    return { ok: true };
  }

  async function unmarkPurchased(card) {
    if (!client) return { ok: false, error: "Sync not ready" };
    const key = cardKey(card);
    if (!key) return { ok: false, error: "Missing card key" };

    const { error } = await client
      .from("toploader_owned_cards")
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

    if (isOwned(card)) {
      return ""; // purchased cards leave the active UI
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
    return isOwned(card) ? "card-bought" : "";
  }

  function catalogFunctionUrl() {
    const cfg = config();
    const base = (cfg.url || "").replace(/\/$/, "");
    return base ? `${base}/functions/v1/toploader-catalog` : "";
  }

  async function resolveSetCatalog(query) {
    const fn = catalogFunctionUrl();
    if (!fn) return { status: "error", message: "Supabase not configured" };
    const cfg = config();
    const url = `${fn}?action=resolve&q=${encodeURIComponent(query || "")}`;
    const res = await fetch(url, {
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${cfg.anonKey}`,
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { status: "error", message: data.message || `Lookup failed (${res.status})` };
    }
    return data;
  }

  window.showSync = {
    init,
    isConfigured,
    isOwned,
    isWishlisted,
    ownedInfo,
    ownedList,
    wishlistList,
    addWishlistCards,
    resolveSetCatalog,
    makeCardKey,
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
