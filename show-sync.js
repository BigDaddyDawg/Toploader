/**
 * Live Chase sync via Supabase (panelbook).
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
  /** @type {Map<string, object>} latest price job per card_key */
  let priceJobsMap = new Map();
  let cardIndex = new Map();
  let ready = false;
  let live = false;
  let channel = null;
  let priceJobPollTimer = 0;
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
        advisor_decision: String(row.advisor_decision || "").trim(),
        floor_justification: String(row.floor_justification || "").trim(),
        card_show_price_note: String(row.card_show_price_note || "").trim(),
        price_status: String(row.price_status || "").trim(),
        priced_at: row.priced_at || "",
        added_by: String(row.added_by || "").trim(),
        added_at: row.added_at || "",
        watchlist_status: 1,
      });
    });
    syncPriceJobPolling();
  }

  function parseTs(raw) {
    if (!raw) return 0;
    const normalized = String(raw).trim().replace(" ", "T");
    const t = Date.parse(normalized);
    return Number.isFinite(t) ? t : 0;
  }

  function jobFreshness(row) {
    const status = String(row.status || "").toLowerCase();
    const terminal = status === "done" || status === "error" ? 1 : 0;
    const ts = parseTs(row.finished_at) || parseTs(row.started_at) || parseTs(row.requested_at);
    return terminal * 1e15 + ts;
  }

  function ingestPriceJobRows(rows) {
    (rows || []).forEach(row => {
      const key = String(row.card_key || "").trim();
      if (!key) return;
      const incoming = {
        id: row.id || "",
        card_key: key,
        status: String(row.status || "").trim().toLowerCase(),
        error_text: String(row.error_text || "").trim(),
        requested_at: row.requested_at || "",
        started_at: row.started_at || "",
        finished_at: row.finished_at || "",
      };
      const existing = priceJobsMap.get(key);
      if (!existing || jobFreshness(incoming) >= jobFreshness(existing)) {
        priceJobsMap.set(key, incoming);
      }
    });
    syncPriceJobPolling();
  }

  function hasActivePriceJobs() {
    for (const job of priceJobsMap.values()) {
      const status = String(job.status || "").toLowerCase();
      if (status === "pending" || status === "running") return true;
    }
    for (const row of wishlistMap.values()) {
      if (String(row.price_status || "").toLowerCase() === "checking") return true;
    }
    return false;
  }

  function syncPriceJobPolling() {
    if (!client || !ready) return;
    const active = hasActivePriceJobs();
    if (active && !priceJobPollTimer) {
      priceJobPollTimer = window.setInterval(() => {
        Promise.all([fetchWishlist(), fetchPriceJobs()]).catch(() => {});
      }, 8000);
    } else if (!active && priceJobPollTimer) {
      window.clearInterval(priceJobPollTimer);
      priceJobPollTimer = 0;
    }
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
      .select("*")
      .order("added_at", { ascending: false });
    if (error) throw error;
    ingestWishlistRows(data);
  }

  async function fetchPriceJobs() {
    if (!client) return;
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const select =
      "id,card_key,status,error_text,requested_at,started_at,finished_at";
    const [activeRes, finishedRes] = await Promise.all([
      client
        .from("toploader_price_jobs")
        .select(select)
        .in("status", ["pending", "running"])
        .order("requested_at", { ascending: false })
        .limit(100),
      client
        .from("toploader_price_jobs")
        .select(select)
        .in("status", ["done", "error"])
        .gte("finished_at", since)
        .order("finished_at", { ascending: false })
        .limit(100),
    ]);
    if (activeRes.error) throw activeRes.error;
    if (finishedRes.error) throw finishedRes.error;
    ingestPriceJobRows([...(activeRes.data || []), ...(finishedRes.data || [])]);
    notifyChange();
  }

  async function refreshAll() {
    await Promise.all([fetchOwned(), fetchWishlist(), fetchPriceJobs()]);
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
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "toploader_price_jobs" },
        () => {
          fetchPriceJobs().catch(() => {});
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
    priceJobsMap = new Map();
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
      // One-time bridge: if live wishlist is empty, seed it from the morning snapshot
      // so Add-set mode doesn't blank the existing floors.json chase list.
      if (wishlistMap.size === 0) {
        const seed = (snapshot?.cards || []).filter(c => Number(c.watchlist_status) === 1 && !isOwned(c));
        if (seed.length) {
          await addWishlistCards(seed, "snapshot");
        }
      }
      subscribe();
      ready = true;
      notifyChange();
      return true;
    } catch (err) {
      console.warn("Chase sync init failed:", err);
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

  function priceCheckFunctionUrl() {
    const cfg = config();
    const base = (cfg.url || "").replace(/\/$/, "");
    return base ? `${base}/functions/v1/toploader-price-check` : "";
  }

  async function wakePriceWorker(cardKey) {
    const fn = priceCheckFunctionUrl();
    const cfg = config();
    if (!fn || !cfg.anonKey) return;
    try {
      await fetch(fn, {
        method: "POST",
        headers: {
          apikey: cfg.anonKey,
          Authorization: `Bearer ${cfg.anonKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ card_key: cardKey || "" }),
      });
    } catch (_) {
      // The queued job still runs on the next scheduled worker pass.
    }
  }

  function recentlyPriced(row, minutes = 20) {
    const raw = row?.priced_at || "";
    if (!raw) return false;
    const d = new Date(raw);
    if (!Number.isFinite(d.getTime())) return false;
    return Date.now() - d.getTime() < minutes * 60 * 1000;
  }

  function priceJobFor(cardOrKey) {
    const key =
      typeof cardOrKey === "string"
        ? String(cardOrKey || "").trim()
        : cardKey(cardOrKey);
    return key ? priceJobsMap.get(key) || null : null;
  }

  function isJobActive(job) {
    const status = String(job?.status || "").toLowerCase();
    return status === "pending" || status === "running";
  }

  async function requestPriceCheck(card, options = {}) {
    if (!client) return { ok: false, error: "Sync not ready" };
    const force = Boolean(options.force);
    const key = cardKey(card);
    if (!key) return { ok: false, error: "Missing card key" };
    const existing = wishlistMap.get(key) || {};
    const activeJob = priceJobFor(key);
    if (isJobActive(activeJob)) {
      wakePriceWorker(key);
      return { ok: true, queued: true, reason: "already-checking" };
    }
    if (!force && recentlyPriced(existing) && String(existing.price_status || "") === "ok") {
      return { ok: true, queued: false, reason: "fresh" };
    }

    const meta = cardIndex.get(key) || existing || card || {};
    const name = String(meta.card || meta.card_name || card.card || "").trim();
    const number = String(meta.number || card.number || "").trim();
    const setName = String(meta.set_name || card.set_name || "").trim();
    const scrape =
      String(meta.scrape_query || card.scrape_query || "").trim() ||
      [name, setName, number].filter(Boolean).join(" ");

    const { data: pending, error: pendingErr } = await client
      .from("toploader_price_jobs")
      .select("id,status")
      .eq("card_key", key)
      .in("status", ["pending", "running"])
      .order("requested_at", { ascending: false })
      .limit(1);
    if (pendingErr) return { ok: false, error: pendingErr.message };
    if (pending && pending.length) {
      ingestPriceJobRows([
        {
          id: pending[0].id,
          card_key: key,
          status: pending[0].status,
          requested_at: new Date().toISOString(),
        },
      ]);
      wishlistMap.set(key, { ...existing, ...card, card_key: key, price_status: "checking" });
      notifyChange();
      wakePriceWorker(key);
      return { ok: true, queued: true, reason: "already-queued" };
    }

    const { error: jobErr } = await client.from("toploader_price_jobs").insert({
      card_key: key,
      card_name: name.slice(0, 200),
      number: number.slice(0, 40),
      set_name: setName.slice(0, 200),
      scrape_query: scrape.slice(0, 400),
      job_type: "card",
      status: "pending",
    });
    if (jobErr) return { ok: false, error: jobErr.message };

    const { error: wishErr } = await client
      .from("toploader_wishlist_cards")
      .update({ price_status: "checking", updated_at: new Date().toISOString() })
      .eq("card_key", key);
    if (wishErr) {
      // Job is queued even if the status column is not on this project yet.
      console.warn("price_status update skipped:", wishErr.message);
    }

    wishlistMap.set(key, {
      ...existing,
      ...card,
      card_key: key,
      card: name,
      card_name: name,
      number,
      set_name: setName,
      scrape_query: scrape,
      price_status: "checking",
      watchlist_status: 1,
    });
    ingestPriceJobRows([
      {
        card_key: key,
        status: "pending",
        requested_at: new Date().toISOString(),
      },
    ]);
    notifyChange();
    wakePriceWorker(key);
    return { ok: true, queued: true };
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
    requestPriceCheck,
    priceJobFor,
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
