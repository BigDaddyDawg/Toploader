/**
 * Phone "Add set" flow: resolve set via Supabase edge function or local
 * set-catalogs.json, pick cards, write to toploader_wishlist_cards.
 */
(function () {
  const CHASE_NEEDLES = [
    "illustration",
    "hyper rare",
    "secret",
    "rainbow",
    "ultra rare",
    "special illustration",
    "double rare",
    "futuristic",
    "mega ultra",
    "promo",
  ];

  const QUICK_SETS = [
    { id: "Chase picks", label: "Your picks" },
    { id: "30th Celebration", label: "30th Celebration" },
    { id: "Delta Reign", label: "Delta Reign" },
  ];

  let lastResult = null;
  let selected = new Set();
  let catalogs = null;
  let catalogsPromise = null;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function isChase(rarity) {
    const low = String(rarity || "").toLowerCase();
    if (!low) return false;
    return CHASE_NEEDLES.some(n => low.includes(n));
  }

  function setNameForCard(card) {
    return card.set_name || lastResult?.set_name || "";
  }

  function cardKeyFor(card, setName) {
    const set = setName || setNameForCard(card);
    if (window.showSync?.makeCardKey) {
      return showSync.makeCardKey(card.name, card.number, set);
    }
    return `${String(card.name || "").toLowerCase()}|${card.number}|${String(set || "").toLowerCase()}`;
  }

  function statusEl() {
    return document.getElementById("addSetStatus");
  }

  function listEl() {
    return document.getElementById("listAddSet");
  }

  function setStatus(msg, isError) {
    const el = statusEl();
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("error", Boolean(isError));
  }

  function loadCatalogs() {
    if (catalogs) return Promise.resolve(catalogs);
    if (catalogsPromise) return catalogsPromise;
    catalogsPromise = fetch(`set-catalogs.json?v=${Date.now()}`, { cache: "no-store" })
      .then(r => {
        if (!r.ok) throw new Error(`Catalog HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        catalogs = data;
        return data;
      })
      .catch(err => {
        catalogsPromise = null;
        throw err;
      });
    return catalogsPromise;
  }

  function catalogToResult(entry) {
    const cards = (entry.cards || []).map(c => ({ ...c }));
    return {
      status: "ok",
      group_id: entry.group_id || null,
      set_name: entry.set_name,
      card_count: cards.length,
      cards,
      note: entry.note || "",
      from_catalog: true,
    };
  }

  function applyResult(result, { preselectChase = false } = {}) {
    lastResult = result;
    selected = new Set();
    if (preselectChase) {
      (result.cards || []).forEach(card => {
        if (isChase(card.rarity)) selected.add(cardKeyFor(card));
      });
    }
    document.getElementById("addSetFilters")?.removeAttribute("hidden");
    document.getElementById("addSetActions")?.removeAttribute("hidden");
    const note = result.note ? ` ${result.note}` : "";
    setStatus(
      `${result.set_name}: ${result.card_count} cards. Tick what you want on wishlist.${note}`
    );
    renderPicker();
  }

  async function openCatalogSet(setId) {
    setStatus("Loading card list…");
    try {
      const data = await loadCatalogs();
      const entry = data?.sets?.[setId];
      if (!entry) {
        setStatus(`No local list for ${setId}.`, true);
        return;
      }
      // Never auto-check — Rachel picks what goes on wishlist.
      applyResult(catalogToResult(entry), { preselectChase: false });
      const input = document.getElementById("addSetQuery");
      if (input) input.value = entry.set_name;
    } catch (err) {
      setStatus(String(err.message || err), true);
    }
  }

  function renderQuickChips() {
    const host = document.getElementById("addSetQuick");
    if (!host || host.dataset.wired === "1") return;
    host.dataset.wired = "1";
    host.innerHTML = QUICK_SETS.map(
      s =>
        `<button type="button" class="toggle-btn add-set-chip" data-catalog-set="${escapeHtml(s.id)}">${escapeHtml(s.label)}</button>`
    ).join("");
    host.querySelectorAll("[data-catalog-set]").forEach(btn => {
      btn.addEventListener("click", () => openCatalogSet(btn.dataset.catalogSet || ""));
    });
  }

  function renderPicker() {
    const list = listEl();
    if (!list || !lastResult) return;
    const chaseOnly = document.getElementById("addSetChaseOnly")?.checked !== false;
    const q = (document.getElementById("addSetCardSearch")?.value || "").trim().toLowerCase();
    let cards = lastResult.cards || [];
    if (chaseOnly) cards = cards.filter(c => isChase(c.rarity));
    if (q) {
      cards = cards.filter(c =>
        [c.name, c.number, c.rarity, c.set_name].join(" ").toLowerCase().includes(q)
      );
    }

    if (!cards.length) {
      list.innerHTML =
        '<div class="empty">No cards match that filter. Try turning off “Chase only”.</div>';
      return;
    }

    const multiSet =
      lastResult.set_name === "Chase picks" ||
      (lastResult.cards || []).some(
        c => c.set_name && c.set_name !== lastResult.set_name
      );
    list.innerHTML = cards
      .map(card => {
        const key = cardKeyFor(card);
        const checked = selected.has(key) ? "checked" : "";
        const img = card.image_small_url
          ? `<img class="card-image" src="${escapeHtml(card.image_small_url)}" alt="" loading="lazy">`
          : '<div class="card-image" aria-hidden="true"></div>';
        const setLine = multiSet
          ? `${escapeHtml(card.set_name || lastResult.set_name || "")} · ${escapeHtml(card.rarity || "—")}${card.promo_note ? ` · ${escapeHtml(card.promo_note)}` : ""}`
          : escapeHtml(card.rarity || "—");
        return `
          <label class="card add-set-card" data-key="${escapeHtml(key)}">
            <div class="wish-row">
              ${img}
              <div class="wish-copy">
                <h2>${escapeHtml(card.name)} <span style="color:var(--muted)">#${escapeHtml(card.number)}</span></h2>
                <p class="wish-set-line">${setLine}</p>
              </div>
              <input type="checkbox" ${checked} data-add-set-key="${escapeHtml(key)}" aria-label="Select ${escapeHtml(card.name)}">
            </div>
          </label>
        `;
      })
      .join("");

    list.querySelectorAll("[data-add-set-key]").forEach(input => {
      input.addEventListener("change", () => {
        const key = input.dataset.addSetKey || "";
        if (!key) return;
        if (input.checked) selected.add(key);
        else selected.delete(key);
        updateSelectedCount();
      });
    });
    updateSelectedCount();
  }

  function updateSelectedCount() {
    const el = document.getElementById("addSetSelectedCount");
    if (el) el.textContent = `${selected.size} selected`;
  }

  async function resolveFromCatalogFallback(q) {
    const data = await loadCatalogs();
    const low = String(q || "").toLowerCase();
    for (const entry of Object.values(data?.sets || {})) {
      const aliases = [entry.set_name, ...(entry.aliases || [])].map(a =>
        String(a).toLowerCase()
      );
      if (aliases.some(a => low.includes(a) || a.includes(low))) {
        return catalogToResult(entry);
      }
    }
    return null;
  }

  async function resolveSet() {
    const input = document.getElementById("addSetQuery");
    const q = (input?.value || "").trim();
    if (!q) {
      setStatus("Tap a set below, or type a set name / paste a link.", true);
      return;
    }
    setStatus("Looking up set…");
    selected = new Set();
    lastResult = null;

    // Prefer local catalogs for the big new sets (TCGCSV is incomplete / sealed-only).
    try {
      const local = await resolveFromCatalogFallback(q);
      if (local && (local.set_name === "Delta Reign" || local.set_name === "Chase picks")) {
        applyResult(local, { preselectChase: false });
        return;
      }
      if (local && local.set_name === "30th Celebration") {
        // Try live first; fall back to local if thin.
      }
    } catch (_) {
      /* ignore */
    }

    if (!window.showSync?.resolveSetCatalog) {
      try {
        const local = await resolveFromCatalogFallback(q);
        if (local) {
          applyResult(local, { preselectChase: false });
          return;
        }
      } catch (err) {
        setStatus(String(err.message || err), true);
        return;
      }
      setStatus("Sync not ready yet — check Supabase config.", true);
      return;
    }

    try {
      const result = await showSync.resolveSetCatalog(q);
      if (result.status === "ok" && (result.card_count || 0) > 0) {
        // Merge local 30th seeds if live list is thin.
        if (
          /30th|celebration/i.test(result.set_name || q) &&
          result.card_count < 40
        ) {
          try {
            const local = await resolveFromCatalogFallback("30th Celebration");
            if (local && local.card_count > result.card_count) {
              applyResult(local, { preselectChase: false });
              return;
            }
          } catch (_) {
            /* ignore */
          }
        }
        applyResult(result, { preselectChase: false });
        return;
      }

      const local = await resolveFromCatalogFallback(q);
      if (local) {
        applyResult(local, { preselectChase: false });
        return;
      }
      setStatus(result.message || "Could not find that set.", true);
      listEl().innerHTML = "";
    } catch (err) {
      try {
        const local = await resolveFromCatalogFallback(q);
        if (local) {
          applyResult(local, { preselectChase: false });
          return;
        }
      } catch (_) {
        /* ignore */
      }
      setStatus(String(err.message || err), true);
    }
  }

  async function addSelected() {
    if (!lastResult) {
      setStatus("Find a set first.", true);
      return;
    }
    if (!selected.size) {
      setStatus("Select at least one card.", true);
      return;
    }
    const byKey = new Map();
    (lastResult.cards || []).forEach(card => {
      byKey.set(cardKeyFor(card), card);
    });
    const rows = [...selected]
      .map(key => {
        const card = byKey.get(key);
        if (!card) return null;
        const setName = setNameForCard(card);
        return {
          card_key: key,
          card_name: card.name,
          number: card.number,
          set_name: setName,
          rarity: card.rarity || "",
          image_small_url: card.image_small_url || "",
          image_large_url: card.image_large_url || "",
          scrape_query: [card.name, setName, card.number].join(" "),
        };
      })
      .filter(Boolean);

    setStatus(`Adding ${rows.length} card(s) to wishlist…`);
    const result = await showSync.addWishlistCards(rows);
    if (!result.ok) {
      setStatus(result.error || "Could not save wishlist.", true);
      return;
    }
    setStatus(
      `Added ${result.count} card(s). They’re on Wishlist now — tap a card when you want a live max buy.`
    );
    selected = new Set();
    updateSelectedCount();
    if (typeof window.chaseOnWishlistChanged === "function") {
      window.chaseOnWishlistChanged();
    }
  }

  function selectAllVisible() {
    if (!lastResult) return;
    const chaseOnly = document.getElementById("addSetChaseOnly")?.checked !== false;
    const q = (document.getElementById("addSetCardSearch")?.value || "").trim().toLowerCase();
    (lastResult.cards || []).forEach(card => {
      if (chaseOnly && !isChase(card.rarity)) return;
      if (
        q &&
        ![card.name, card.number, card.rarity, card.set_name]
          .join(" ")
          .toLowerCase()
          .includes(q)
      ) {
        return;
      }
      selected.add(cardKeyFor(card));
    });
    renderPicker();
  }

  function clearSelection() {
    selected = new Set();
    renderPicker();
  }

  function wire() {
    renderQuickChips();
    document.getElementById("addSetFindBtn")?.addEventListener("click", resolveSet);
    document.getElementById("addSetQuery")?.addEventListener("keydown", ev => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        resolveSet();
      }
    });
    document.getElementById("addSetChaseOnly")?.addEventListener("change", renderPicker);
    document.getElementById("addSetCardSearch")?.addEventListener("input", renderPicker);
    document.getElementById("addSetAddBtn")?.addEventListener("click", addSelected);
    document.getElementById("addSetSelectVisible")?.addEventListener("click", selectAllVisible);
    document.getElementById("addSetClearSel")?.addEventListener("click", clearSelection);
    // Warm the catalog cache; ignore failures until user taps.
    loadCatalogs().catch(() => {});
  }

  window.chaseSetIntake = { wire, renderPicker, openCatalogSet };
})();
