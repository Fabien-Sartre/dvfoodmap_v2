/* ==========================================================
   DV Food Map v2 — logique applicative
   Supabase (auth + données) · Leaflet (carte) · Nominatim (géocodage)
   ========================================================== */
(() => {
  "use strict";
  const C = window.DVFM;
  // Mode démo publique (?demo=1) : lecture seule depuis demo-data.js.
  // Aucun client Supabase créé, aucune requête vers le backend.
  const DEMO = new URLSearchParams(location.search).has("demo");
  const sb = DEMO ? null : window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);

  // ---------- état ----------
  let session = null;
  let isAdmin = false;
  let profiles = {};            // user_id -> display_name
  let restos = [];              // lignes de restaurants_with_stats + _walk
  let map = null, markersLayer = null, markerById = {};
  let currentResto = null;      // resto ouvert dans le panneau
  let myRating = 4;             // note en cours de saisie (étoiles)
  let editingResto = null;      // resto en cours d'édition dans la modale
  let geo = null;               // {lat,lng,label} résultat de géocodage validé
  let priceSel = "";            // prix choisi dans la modale
  let tagsSel = new Set();      // tags choisis dans la modale
  let sortMode = "rating";
  const filters = { q: "", minRating: 0, maxWalk: 31, prices: new Set(), foods: new Set(), tags: new Set() };

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  const fmtNote = n => Number(n).toFixed(1).replace(".", ",");
  const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

  // ---------- distance à pied ----------
  function haversine(aLat, aLng, bLat, bLng) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
    const h = Math.sin(dLat/2)**2 + Math.cos(aLat*r) * Math.cos(bLat*r) * Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function walkMin(lat, lng) {
    const m = Math.min(...C.OFFICES.map(o => haversine(lat, lng, o.lat, o.lng)));
    return Math.max(1, Math.round(m * C.WALK.DETOUR / C.WALK.SPEED));
  }

  // ---------- toast ----------
  let toastTimer = null;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
  }

  // ==========================================================
  // Authentification
  // ==========================================================
  let authMode = "login";

  function setAuthMode(mode) {
    authMode = mode;
    $("auth-tab-login").classList.toggle("active", mode === "login");
    $("auth-tab-signup").classList.toggle("active", mode === "signup");
    $("auth-domain-note").classList.toggle("hidden", mode !== "signup");
    $("auth-submit").textContent = mode === "login" ? "Se connecter" : "Créer mon compte";
    $("auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
    $("auth-resend").classList.add("hidden");
    authMsg(null);
  }
  function authMsg(text, ok = false) {
    const el = $("auth-msg");
    if (!text) { el.classList.add("hidden"); return; }
    el.textContent = text;
    el.className = "msg " + (ok ? "msg-ok" : "msg-error");
  }
  function friendlyAuthError(error) {
    const m = (error?.message || "").toLowerCase();
    const code = error?.code || "";
    if (code === "invalid_credentials" || m.includes("invalid login")) return "Email ou mot de passe incorrect.";
    if (code === "email_not_confirmed" || m.includes("not confirmed")) return "Ton compte n'est pas encore confirmé : clique sur le lien reçu par email (vérifie aussi les indésirables).";
    if (code === "over_email_send_rate_limit" || m.includes("rate limit")) return "Trop d'emails envoyés pour le moment — réessaie dans une heure.";
    if (code === "user_already_exists" || m.includes("already registered")) return "Un compte existe déjà avec cet email. Connecte-toi.";
    if (m.includes("database error saving new user")) return "Inscription réservée aux adresses @" + C.EMAIL_DOMAIN + ".";
    if (code === "weak_password" || m.includes("password")) return "Mot de passe trop court : 8 caractères minimum.";
    return "Une erreur est survenue : " + (error?.message || "réessaie.");
  }

  async function handleAuthSubmit(e) {
    e.preventDefault();
    const email = $("auth-email").value.trim().toLowerCase();
    const password = $("auth-password").value;
    if (!email || !password) { authMsg("Renseigne ton email et ton mot de passe."); return; }
    const btn = $("auth-submit");
    btn.disabled = true;

    if (authMode === "signup") {
      if (!email.endsWith("@" + C.EMAIL_DOMAIN)) {
        authMsg("L'inscription est réservée aux adresses @" + C.EMAIL_DOMAIN + ".");
        btn.disabled = false; return;
      }
      // emailRedirectTo : le lien de confirmation ramène ici (prod ou localhost),
      // sans dépendre de la Site URL configurée côté Supabase.
      const { data, error } = await sb.auth.signUp({
        email, password,
        options: { emailRedirectTo: location.origin + location.pathname }
      });
      btn.disabled = false;
      if (error) { authMsg(friendlyAuthError(error)); return; }
      // Supabase renvoie un utilisateur sans identité quand l'email existe déjà
      if (data?.user && (data.user.identities || []).length === 0) {
        authMsg("Un compte existe déjà avec cet email. Connecte-toi.");
        return;
      }
      authMsg("Compte créé. Ouvre l'email de confirmation qui vient de t'être envoyé, puis connecte-toi.", true);
      setAuthMode("login");
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      btn.disabled = false;
      if (error) {
        const unconfirmed = error?.code === "email_not_confirmed"
          || (error?.message || "").toLowerCase().includes("not confirmed");
        $("auth-resend").classList.toggle("hidden", !unconfirmed);
        authMsg(friendlyAuthError(error));
        return;
      }
      // onAuthStateChange prend le relais
    }
  }

  async function handleResend() {
    const email = $("auth-email").value.trim().toLowerCase();
    if (!email) { authMsg("Saisis d'abord ton email."); return; }
    const { error } = await sb.auth.resend({
      type: "signup", email,
      options: { emailRedirectTo: location.origin + location.pathname }
    });
    if (error) { authMsg(friendlyAuthError(error)); return; }
    $("auth-resend").classList.add("hidden");
    authMsg("Email de confirmation renvoyé — vérifie ta boîte (et les indésirables).", true);
  }

  async function handleForgot() {
    const email = $("auth-email").value.trim().toLowerCase();
    if (!email) { authMsg("Saisis d'abord ton email, puis reclique sur « Mot de passe oublié »."); return; }
    const redirect = location.origin + location.pathname;
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirect });
    if (error) { authMsg(friendlyAuthError(error)); return; }
    authMsg("Email envoyé : clique sur le lien reçu pour choisir un nouveau mot de passe.", true);
  }

  function showAuth() {
    currentResto = null;
    $("panel").classList.remove("open");
    $("app").classList.add("hidden");
    $("auth").classList.remove("hidden");
  }

  // ==========================================================
  // Données
  // ==========================================================
  async function loadProfiles() {
    const { data, error } = await sb.from("profiles").select("id, display_name");
    if (error) { console.error(error); return; }
    profiles = Object.fromEntries((data || []).map(p => [p.id, p.display_name]));
  }

  async function loadRestos() {
    if (DEMO) {
      restos = (window.DEMO_DATA?.restaurants || []).map(r => ({ ...r, avg_rating: Number(r.avg_rating), _walk: walkMin(r.lat, r.lng) }));
      return;
    }
    const { data, error } = await sb.from("restaurants_with_stats").select("*");
    if (error) { console.error(error); toast("Impossible de charger les restaurants."); return; }
    restos = (data || []).map(r => ({ ...r, avg_rating: Number(r.avg_rating), _walk: walkMin(r.lat, r.lng) }));
  }

  async function loadReviews(restaurantId) {
    const { data, error } = await sb.from("reviews")
      .select("id, user_id, rating, comment, created_at")
      .eq("restaurant_id", restaurantId)
      .order("created_at", { ascending: false });
    if (error) { console.error(error); return []; }
    return data || [];
  }

  // ==========================================================
  // Carte
  // ==========================================================
  function ratingColor(n) {
    if (!Number.isFinite(n) || n <= 0) return null;
    const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
    const BAD = [217, 67, 95], MID = [233, 162, 59], GOOD = [30, 158, 106];
    const c = n <= 3
      ? lerp(BAD, MID, Math.max(0, (n - 0.5) / 2.5))
      : lerp(MID, GOOD, (n - 3) / 2);
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  function pinIcon(avg, selected) {
    const color = ratingColor(avg);
    const label = color ? fmtNote(avg) : "–";
    const fill = color || "#FFFFFF";
    const text = color ? "#fff" : "#8C9096";
    const stroke = color ? "#fff" : "#A7ABB0";
    const tail = color || "#A7ABB0";
    const html = `
<svg width="36" height="44" viewBox="0 0 36 44" xmlns="http://www.w3.org/2000/svg">
  <path d="M18 43 L12.5 29 H23.5 Z" fill="${tail}"/>
  <circle cx="18" cy="16" r="14" fill="${fill}" stroke="${stroke}" stroke-width="2.5"/>
  <text x="18" y="20.5" text-anchor="middle" font-size="11.5" font-weight="600" fill="${text}"
        font-family="'Spline Sans Mono',monospace">${label}</text>
</svg>`;
    return L.divIcon({
      className: "pin-icon" + (selected ? " selected" : ""),
      html, iconSize: [36, 44], iconAnchor: [18, 43], tooltipAnchor: [0, -40]
    });
  }

  function officeIcon() {
    const html = `
<svg width="34" height="42" viewBox="0 0 36 44" xmlns="http://www.w3.org/2000/svg">
  <path d="M18 43 L12.5 29 H23.5 Z" fill="#16181D"/>
  <circle cx="18" cy="16" r="14" fill="#16181D" stroke="#fff" stroke-width="2.5"/>
  <text x="18" y="20.5" text-anchor="middle" font-size="11" font-weight="600" fill="#fff"
        font-family="'Spline Sans Mono',monospace">DV</text>
</svg>`;
    return L.divIcon({ className: "pin-icon", html, iconSize: [34, 42], iconAnchor: [17, 41], tooltipAnchor: [0, -40] });
  }

  function initMap() {
    const o = C.OFFICES[0];
    map = L.map("map", { zoomControl: false }).setView([o.lat, o.lng], 16);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap &amp; CARTO", subdomains: "abcd", maxZoom: 20
    }).addTo(map);

    // signature : anneaux "minutes à pied" autour de chaque bureau
    C.OFFICES.forEach(off => {
      C.RINGS_MIN.forEach(min => {
        const radius = min * C.WALK.SPEED / C.WALK.DETOUR; // mètres à vol d'oiseau
        L.circle([off.lat, off.lng], {
          radius, color: "#2742F5", weight: 1, dashArray: "3 7",
          opacity: 0.45, fillOpacity: 0, interactive: false
        }).addTo(map);
        // étiquette posée au nord-est de l'anneau
        const dLat = (radius * Math.SQRT1_2) / 111320;
        const dLng = (radius * Math.SQRT1_2) / (111320 * Math.cos(off.lat * Math.PI / 180));
        L.marker([off.lat + dLat, off.lng + dLng], {
          icon: L.divIcon({ className: "ring-label", html: `${min} min`, iconSize: null }),
          interactive: false, keyboard: false
        }).addTo(map);
      });
      L.marker([off.lat, off.lng], { icon: officeIcon(), zIndexOffset: 500 })
        .addTo(map)
        .bindTooltip(off.name, { className: "dv-tip", direction: "top" });
    });

    markersLayer = L.layerGroup().addTo(map);
    map.on("click", closePanel);
  }

  function renderMarkers(list) {
    markersLayer.clearLayers();
    markerById = {};
    list.forEach(r => {
      const m = L.marker([r.lat, r.lng], { icon: pinIcon(r.avg_rating, currentResto?.id === r.id) })
        .bindTooltip(r.name, { className: "dv-tip", direction: "top" })
        .on("click", ev => { L.DomEvent.stopPropagation(ev); openPanel(r); });
      markerById[r.id] = m;
      markersLayer.addLayer(m);
    });
  }

  // ==========================================================
  // Filtres, tri, rendus
  // ==========================================================
  const PRICES = ["€", "€€", "€€€", "€€€€"];

  function foodValues() {
    return [...new Set(restos.map(r => (r.food_type || "").trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "fr"));
  }

  function passFilters(r) {
    if (filters.q) {
      const hay = norm(r.name + " " + (r.food_type || "") + " " + r.address);
      if (!hay.includes(norm(filters.q))) return false;
    }
    if (filters.minRating > 0 && !(r.avg_rating >= filters.minRating)) return false;
    if (filters.maxWalk < 31 && r._walk > filters.maxWalk) return false;
    if (filters.prices.size && !filters.prices.has((r.price_range || "").trim())) return false;
    if (filters.foods.size && !filters.foods.has((r.food_type || "").trim())) return false;
    if (filters.tags.size && ![...filters.tags].every(t => (r.tags || []).includes(t))) return false;
    return true;
  }

  function sorted(list) {
    const by = {
      rating: (a, b) => (b.avg_rating || 0) - (a.avg_rating || 0) || a._walk - b._walk,
      walk:   (a, b) => a._walk - b._walk || (b.avg_rating || 0) - (a.avg_rating || 0),
      new:    (a, b) => new Date(b.created_at) - new Date(a.created_at)
    };
    return [...list].sort(by[sortMode]);
  }

  function activeFilterCount() {
    return (filters.minRating > 0) + (filters.maxWalk < 31) + (filters.prices.size > 0) + (filters.foods.size > 0) + (filters.tags.size > 0);
  }

  function renderChips(containerId, values, set, titleOf, onToggle = renderAll) {
    const box = $(containerId);
    box.innerHTML = "";
    values.forEach(v => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (set.has(v) ? " on" : "");
      b.textContent = v;
      if (titleOf) b.title = titleOf(v);
      b.addEventListener("click", () => {
        set.has(v) ? set.delete(v) : set.add(v);
        b.classList.toggle("on");
        onToggle();
      });
      box.appendChild(b);
    });
    if (!values.length) box.innerHTML = '<span class="no-review">Rien à filtrer pour l\'instant.</span>';
  }

  function priceLegend() {
    return PRICES.map(p => `${p} ${C.PRICE_INFO[p]}`).join(" · ") + " € par personne";
  }
  function renderFilterWidgets() {
    renderChips("f-prices", PRICES, filters.prices, v => `${C.PRICE_INFO[v]} € par personne`);
    renderChips("f-foods", foodValues(), filters.foods);
    renderChips("f-tags", C.TAGS, filters.tags);
    $("price-legend").textContent = priceLegend();
    $("food-options").innerHTML = foodValues().map(f => `<option value="${esc(f)}">`).join("");
  }

  function setRangeFill(el) {
    const pct = (el.value - el.min) / (el.max - el.min) * 100;
    el.style.backgroundSize = pct + "% 100%";
  }

  function starsHtml(n) {
    const pct = Math.max(0, Math.min(5, n)) / 5 * 100;
    return `<span class="stars">★★★★★<span class="fill" style="width:${pct}%">★★★★★</span></span>`;
  }

  function renderList(list) {
    const ul = $("list-rows");
    ul.innerHTML = "";
    list.forEach(r => {
      const li = document.createElement("li");
      li.className = "row";
      li.tabIndex = 0;
      const color = ratingColor(r.avg_rating);
      const meta = [r.food_type, r.price_range].filter(Boolean).join(" · ");
      li.innerHTML = `
        <span class="note ${color ? "" : "na"}" ${color ? `style="background:${color}"` : ""}>${color ? fmtNote(r.avg_rating) : "–"}</span>
        <span class="body"><b>${esc(r.name)}</b><span class="meta">${esc(meta || r.address)}</span></span>
        <span class="right">
          <span class="walk-chip">${r._walk} min à pied</span>
          <span class="avis">${r.reviews_count} avis</span>
        </span>`;
      const open = () => { openPanel(r); };
      li.addEventListener("click", open);
      li.addEventListener("keydown", e => { if (e.key === "Enter") open(); });
      ul.appendChild(li);
    });
    $("list-empty").classList.toggle("hidden", restos.length > 0);
  }

  function renderAll() {
    const visible = sorted(restos.filter(passFilters));
    renderMarkers(visible);
    renderList(visible);
    $("count-label").textContent = restos.length
      ? `${visible.length}/${restos.length} resto${restos.length > 1 ? "s" : ""}`
      : "";
    const n = activeFilterCount();
    $("filters-badge").textContent = n;
    $("filters-badge").classList.toggle("hidden", n === 0);
    $("map-empty").classList.toggle("hidden", restos.length > 0);
  }

  // ==========================================================
  // Panneau de détail
  // ==========================================================
  async function openPanel(r) {
    currentResto = r;
    $("p-name").textContent = r.name;
    $("p-address").textContent = r.address;
    const chips = [];
    chips.push(`<span class="walk-chip">${r._walk} min à pied</span>`);
    if (r.food_type) chips.push(`<span class="pill">${esc(r.food_type)}</span>`);
    if (r.price_range) chips.push(`<span class="pill mono" title="Par personne">${esc(r.price_range)} · ${esc(C.PRICE_INFO[r.price_range] || "")} €</span>`);
    (r.tags || []).forEach(t => chips.push(`<span class="pill">${esc(t)}</span>`));
    chips.push(`<a class="pill pill-action" target="_blank" rel="noopener"
      href="https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=${r.lat},${r.lng}">Itinéraire ↗</a>`);
    chips.push(`<button class="pill pill-action" id="p-share" type="button">Copier le lien</button>`);
    $("p-chips").innerHTML = chips.join("");
    $("p-share").addEventListener("click", async () => {
      const url = location.origin + location.pathname + "#resto=" + r.id;
      try { await navigator.clipboard.writeText(url); toast("Lien copié — colle-le à tes collègues"); }
      catch { prompt("Copie ce lien :", url); }
    });
    $("p-reviews").innerHTML = DEMO
      ? '<div class="no-review">Les avis individuels sont masqués dans la démo.</div>'
      : '<div class="no-review">Chargement…</div>';

    const canEdit = !DEMO && (r.added_by === session.user.id || isAdmin);
    $("p-added").innerHTML = DEMO ? "" : `Ajouté par ${esc(profiles[r.added_by] || "un ancien membre")}` +
      (canEdit ? ` — <button id="p-edit" type="button">modifier la fiche</button>` : "");
    if (canEdit) $("p-edit").addEventListener("click", () => openRestoModal(r));

    $("panel").classList.add("open");
    renderMarkers(sorted(restos.filter(passFilters))); // rafraîchit le pin sélectionné
    if (!$("view-map").classList.contains("hidden")) map.panTo([r.lat, r.lng]);

    if (DEMO) return; // pas d'avis individuels ni de formulaire en démo
    const reviews = await loadReviews(r.id);
    if (currentResto?.id !== r.id) return; // le panneau a changé entre-temps
    renderReviews(reviews);
  }

  function renderReviews(reviews) {
    const mineRow = reviews.find(v => v.user_id === session.user.id);
    const others = reviews.filter(v => v.user_id !== session.user.id);
    const rows = (mineRow ? [mineRow, ...others] : others).map(v => `
      <div class="review">
        <div class="who">
          <b>${esc(profiles[v.user_id] || "Ancien membre")}${v.user_id === session.user.id ? " (toi)" : ""}</b>
          ${starsHtml(Number(v.rating))}
          <time>${new Date(v.created_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}</time>
        </div>
        ${v.comment ? `<p>${esc(v.comment)}</p>` : ""}
      </div>`).join("");
    $("p-reviews").innerHTML = rows || '<div class="no-review">Aucun avis pour l\'instant — le tien peut être le premier.</div>';

    // pré-remplit "votre avis" — formulaire replié par défaut
    myRating = mineRow ? Number(mineRow.rating) : 4;
    paintStars(myRating);
    $("my-comment").value = mineRow?.comment || "";
    $("btn-review-save").textContent = mineRow ? "Mettre à jour mon avis" : "Publier mon avis";
    $("btn-review-delete").classList.toggle("hidden", !mineRow);
    $("btn-review-open").textContent = mineRow ? "Modifier mon avis" : "Laisser un avis";
    $("btn-review-open").classList.remove("hidden");
    $("myreview").classList.add("hidden");
  }

  // ---------- saisie de note par étoiles (demi-étoiles au clic gauche/droit) ----------
  function paintStars(v) {
    document.querySelectorAll("#star-input .st").forEach((st, i) => {
      const part = Math.max(0, Math.min(1, v - i));
      st.querySelector(".fi").style.width = (part * 100) + "%";
    });
    $("my-rating-val").textContent = fmtNote(v);
    $("star-input").setAttribute("aria-valuenow", v);
  }
  function buildStarInput() {
    const box = $("star-input");
    box.innerHTML = Array.from({ length: 5 }, () => '<span class="st">★<span class="fi">★</span></span>').join("");
    const valueAt = (st, i, e) => {
      const rect = st.getBoundingClientRect();
      const x = (e.touches?.[0]?.clientX ?? e.clientX) - rect.left;
      return i + (x < rect.width / 2 ? 0.5 : 1);
    };
    box.querySelectorAll(".st").forEach((st, i) => {
      st.addEventListener("mousemove", e => paintStars(valueAt(st, i, e)));  // aperçu au survol
      st.addEventListener("click", e => { myRating = valueAt(st, i, e); paintStars(myRating); });
    });
    box.addEventListener("mouseleave", () => paintStars(myRating));
    box.addEventListener("keydown", e => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      myRating = Math.max(0.5, Math.min(5, myRating + (e.key === "ArrowRight" ? 0.5 : -0.5)));
      paintStars(myRating);
    });
  }

  function closePanel() {
    if (!currentResto) return;
    currentResto = null;
    $("panel").classList.remove("open");
    if (location.hash.startsWith("#resto=")) history.replaceState(null, "", "#carte");
    renderAll();
  }

  async function saveReview() {
    if (!currentResto) return;
    const btn = $("btn-review-save");
    btn.disabled = true;
    const { error } = await sb.from("reviews").upsert({
      restaurant_id: currentResto.id,
      user_id: session.user.id,
      rating: myRating,
      comment: $("my-comment").value.trim() || null
    }, { onConflict: "restaurant_id,user_id" });
    btn.disabled = false;
    if (error) { console.error(error); toast("L'avis n'a pas pu être enregistré."); return; }
    toast("Avis publié");
    await refreshAfterWrite();
  }

  async function deleteReview() {
    if (!currentResto) return;
    const { error } = await sb.from("reviews").delete()
      .eq("restaurant_id", currentResto.id).eq("user_id", session.user.id);
    if (error) { console.error(error); toast("Suppression impossible."); return; }
    toast("Avis supprimé");
    await refreshAfterWrite();
  }

  async function refreshAfterWrite() {
    const keepId = currentResto?.id;
    await loadRestos();
    renderFilterWidgets();
    renderAll();
    if (keepId) {
      const fresh = restos.find(x => x.id === keepId);
      if (fresh) await openPanel(fresh);
    }
  }

  // ==========================================================
  // Modale ajout / édition de restaurant
  // ==========================================================
  function mrMsg(text) {
    const el = $("mr-msg");
    if (!text) { el.classList.add("hidden"); return; }
    el.textContent = text;
    el.className = "msg msg-error";
  }
  function setPrice(v) {
    priceSel = v;
    document.querySelectorAll("#r-prices button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  }
  function updateRestoSaveState() {
    $("btn-resto-save").disabled = !($("r-name").value.trim() && geo);
  }

  function openRestoModal(resto = null) {
    if (DEMO) return; // lecture seule
    editingResto = resto;
    $("mr-title").textContent = resto ? "Modifier la fiche" : "Ajouter un restaurant";
    $("btn-resto-save").textContent = resto ? "Enregistrer" : "Ajouter à la carte";
    $("r-name").value = resto?.name || "";
    $("r-address").value = resto?.address || "";
    $("r-food").value = resto?.food_type || "";
    setPrice(resto?.price_range || "");
    tagsSel = new Set(resto?.tags || []);
    renderChips("r-tags", C.TAGS, tagsSel, null, () => {});
    geo = resto ? { lat: resto.lat, lng: resto.lng, label: resto.address } : null;
    $("geo-result").textContent = resto ? "Position actuelle conservée (relocalise si l'adresse change)." : "";
    $("geo-result").className = resto ? "ok" : "";
    $("price-hint").textContent = priceLegend();
    $("btn-resto-delete").classList.toggle("hidden", !(resto && isAdmin));
    mrMsg(null);
    updateRestoSaveState();
    $("modal-resto").classList.remove("hidden");
    $("r-name").focus();
  }
  function closeRestoModal() { $("modal-resto").classList.add("hidden"); }

  async function geocode() {
    const addr = $("r-address").value.trim();
    if (!addr) { mrMsg("Saisis d'abord une adresse."); return; }
    const btn = $("btn-geocode");
    btn.disabled = true; btn.textContent = "…";
    const out = $("geo-result");
    try {
      const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=fr&q=" + encodeURIComponent(addr);
      const res = await fetch(url, { headers: { "Accept": "application/json" } });
      const arr = await res.json();
      if (!arr.length) {
        geo = null;
        out.textContent = "Adresse introuvable — précise la rue et la ville (ex. « 12 rue Machin, 75009 Paris »).";
        out.className = "err";
      } else {
        const lat = Number(arr[0].lat), lng = Number(arr[0].lon);
        const g = C.GEOFENCE;
        if (lat < g.latMin || lat > g.latMax || lng < g.lngMin || lng > g.lngMax) {
          geo = null;
          const km = Math.round(Math.min(...C.OFFICES.map(o => haversine(lat, lng, o.lat, o.lng))) / 1000);
          out.textContent = `Ce lieu est à ${km.toLocaleString("fr-FR")} km du bureau — vérifie l'adresse 😄 (la carte est limitée à la région parisienne).`;
          out.className = "err";
        } else {
          geo = { lat, lng, label: arr[0].display_name };
          out.textContent = "✓ " + arr[0].display_name;
          out.className = "ok";
        }
      }
    } catch {
      geo = null;
      out.textContent = "Le service de localisation ne répond pas — réessaie dans quelques secondes.";
      out.className = "err";
    }
    btn.disabled = false; btn.textContent = "Localiser";
    updateRestoSaveState();
  }

  async function saveResto() {
    const name = $("r-name").value.trim();
    if (!name || !geo) return;
    const payload = {
      name,
      address: $("r-address").value.trim(),
      lat: geo.lat, lng: geo.lng,
      food_type: $("r-food").value.trim() || null,
      price_range: priceSel || null,
      tags: [...tagsSel]
    };
    const btn = $("btn-resto-save");
    btn.disabled = true;
    const q = editingResto
      ? sb.from("restaurants").update(payload).eq("id", editingResto.id)
      : sb.from("restaurants").insert(payload);
    const { error } = await q;
    btn.disabled = false;
    if (error) {
      console.error(error);
      if (error.code === "23505") mrMsg("Ce restaurant est déjà sur la carte.");
      else if ((error.message || "").includes("restaurants_zone_paris")) mrMsg("Ce lieu est hors de la région parisienne — la carte s'arrête là. 😄");
      else mrMsg("Enregistrement impossible : " + error.message);
      return;
    }
    closeRestoModal();
    toast(editingResto ? "Fiche mise à jour" : "Restaurant ajouté à la carte");
    const keepName = name;
    editingResto = null;
    await loadRestos();
    renderFilterWidgets();
    renderAll();
    const added = restos.find(r => r.name === keepName);
    if (added) {
      map.setView([added.lat, added.lng], Math.max(map.getZoom(), 16));
      openPanel(added);
    }
  }

  // ==========================================================
  // Navigation (#carte / #liste) & popover filtres
  // ==========================================================
  function applyRoute() {
    const h = location.hash;
    const list = h === "#liste";
    $("view-map").classList.toggle("hidden", list);
    $("view-list").classList.toggle("hidden", !list);
    $("tab-map").classList.toggle("active", !list);
    $("tab-list").classList.toggle("active", list);
    if (!list && map) setTimeout(() => map.invalidateSize(), 60);
    // lien direct vers une fiche : …/#resto=<id>
    if (h.startsWith("#resto=")) {
      const r = restos.find(x => x.id === h.slice(7));
      if (r) { map.setView([r.lat, r.lng], Math.max(map.getZoom(), 16)); openPanel(r); }
    }
  }

  function toggleFilters(force) {
    const pop = $("filters-pop");
    const show = force !== undefined ? force : pop.classList.contains("hidden");
    pop.classList.toggle("hidden", !show);
  }

  // ==========================================================
  // Démarrage de l'app
  // ==========================================================
  let booted = false;
  async function bootApp() {
    $("auth").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("user-name").textContent = profilesName();
    if (!booted) {
      booted = true;
      initMap();
      wireApp();
    }
    if (DEMO) {
      await loadRestos(); // demo-data.js, aucune requête réseau
    } else {
      const [, , adm] = await Promise.all([loadProfiles(), loadRestos(), sb.rpc("is_admin")]);
      isAdmin = adm?.data === true;
      $("user-name").textContent = profilesName();
    }
    renderFilterWidgets();
    renderAll();
    applyRoute();
  }
  function profilesName() {
    return profiles[session?.user?.id] || session?.user?.email || "";
  }

  function wireApp() {
    // barre du haut
    $("btn-logout").addEventListener("click", async () => { await sb.auth.signOut(); });
    $("btn-add").addEventListener("click", () => openRestoModal());
    $("btn-add-empty").addEventListener("click", () => openRestoModal());
    window.addEventListener("hashchange", applyRoute);

    // "choisis pour moi" : tirage au sort parmi les filtres actifs
    $("btn-random").addEventListener("click", () => {
      const pool = restos.filter(passFilters);
      if (!pool.length) { toast("Aucun resto ne passe les filtres — élargis un peu."); return; }
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (location.hash === "#liste") { location.hash = "#carte"; }
      map.setView([pick.lat, pick.lng], Math.max(map.getZoom(), 16));
      openPanel(pick);
      toast(`Le sort a parlé : ${pick.name} 🎲`);
    });

    // recherche & filtres
    $("q").addEventListener("input", () => { filters.q = $("q").value; renderAll(); });
    $("btn-filters").addEventListener("click", e => { e.stopPropagation(); toggleFilters(); });
    $("filters-pop").addEventListener("click", e => e.stopPropagation());
    document.addEventListener("click", () => toggleFilters(false));
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") { toggleFilters(false); closePanel(); closeRestoModal(); }
    });

    const fr = $("f-rating"), fw = $("f-walk");
    fr.addEventListener("input", () => {
      filters.minRating = Number(fr.value);
      $("f-rating-val").textContent = filters.minRating > 0 ? "≥ " + fmtNote(filters.minRating) : "Toutes";
      setRangeFill(fr); renderAll();
    });
    fw.addEventListener("input", () => {
      filters.maxWalk = Number(fw.value);
      $("f-walk-val").textContent = filters.maxWalk > 30 ? "Sans limite" : "≤ " + filters.maxWalk + " min";
      setRangeFill(fw); renderAll();
    });
    $("btn-filters-reset").addEventListener("click", () => {
      filters.q = ""; $("q").value = "";
      filters.minRating = 0; fr.value = 0; $("f-rating-val").textContent = "Toutes";
      filters.maxWalk = 31; fw.value = 31; $("f-walk-val").textContent = "Sans limite";
      filters.prices.clear(); filters.foods.clear(); filters.tags.clear();
      setRangeFill(fr); setRangeFill(fw);
      renderFilterWidgets(); renderAll();
    });
    setRangeFill(fr); setRangeFill(fw);

    // tri de la liste
    [["sort-rating", "rating"], ["sort-walk", "walk"], ["sort-new", "new"]].forEach(([id, mode]) => {
      $(id).addEventListener("click", () => {
        sortMode = mode;
        document.querySelectorAll(".sort-row button").forEach(b => b.classList.toggle("active", b.id === id));
        renderAll();
      });
    });

    // panneau
    $("p-close").addEventListener("click", closePanel);
    buildStarInput();
    $("btn-review-save").addEventListener("click", saveReview);
    $("btn-review-delete").addEventListener("click", deleteReview);
    $("btn-review-open").addEventListener("click", () => {
      $("btn-review-open").classList.add("hidden");
      $("myreview").classList.remove("hidden");
      $("my-comment").focus();
    });
    $("btn-review-cancel").addEventListener("click", () => {
      $("myreview").classList.add("hidden");
      $("btn-review-open").classList.remove("hidden");
    });

    // modale resto
    $("btn-geocode").addEventListener("click", geocode);
    $("r-address").addEventListener("input", () => {
      geo = null; $("geo-result").textContent = ""; updateRestoSaveState();
    });
    $("r-name").addEventListener("input", updateRestoSaveState);
    document.querySelectorAll("#r-prices button").forEach(b =>
      b.addEventListener("click", () => setPrice(b.dataset.v === priceSel ? "" : b.dataset.v)));
    $("btn-resto-cancel").addEventListener("click", closeRestoModal);
    $("btn-resto-save").addEventListener("click", saveResto);
    $("btn-resto-delete").addEventListener("click", async () => {
      if (!editingResto || !isAdmin) return;
      if (!confirm(`Supprimer « ${editingResto.name} » et tous ses avis ? C'est définitif.`)) return;
      const { error } = await sb.from("restaurants").delete().eq("id", editingResto.id);
      if (error) { console.error(error); mrMsg("Suppression impossible : " + error.message); return; }
      closeRestoModal();
      closePanel();
      toast("Restaurant supprimé");
      editingResto = null;
      await loadRestos();
      renderFilterWidgets();
      renderAll();
    });
    $("modal-resto").addEventListener("click", e => { if (e.target.id === "modal-resto") closeRestoModal(); });

    // nouveau mot de passe (retour du lien "mot de passe oublié")
    $("btn-pass-save").addEventListener("click", async () => {
      const pwd = $("np-password").value;
      if (pwd.length < 8) { toast("8 caractères minimum."); return; }
      const { error } = await sb.auth.updateUser({ password: pwd });
      if (error) { toast("Impossible de changer le mot de passe."); return; }
      $("modal-pass").classList.add("hidden");
      toast("Mot de passe mis à jour");
    });
  }

  // ---------- auth wiring + point d'entrée ----------
  if (DEMO) {
    document.body.classList.add("demo"); // masque les actions d'écriture (styles.css)
    bootApp();
  } else {
    $("auth-tab-login").addEventListener("click", () => setAuthMode("login"));
    $("auth-tab-signup").addEventListener("click", () => setAuthMode("signup"));
    $("auth-form").addEventListener("submit", handleAuthSubmit);
    $("auth-forgot").addEventListener("click", handleForgot);
    $("auth-resend").addEventListener("click", handleResend);

    sb.auth.onAuthStateChange((event, s) => {
      session = s;
      if (event === "PASSWORD_RECOVERY") {
        $("modal-pass").classList.remove("hidden");
        return;
      }
      if (event === "SIGNED_OUT" || !s) { showAuth(); return; }
      if (event === "INITIAL_SESSION" || event === "SIGNED_IN") bootApp();
    });
  }
})();
