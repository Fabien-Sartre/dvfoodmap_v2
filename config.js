// Configuration publique du site (la clé anon est faite pour être exposée ;
// toute la sécurité est portée par les policies RLS côté Supabase).
window.DVFM = {
  SUPABASE_URL: "https://mhhnweokygfovbffooiw.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_CqR0ZhgdAUkp-A_kTYYU0Q_vY4Za2EH",
  EMAIL_DOMAIN: "digitalvalue.fr",
  // Plusieurs bureaux possibles : le temps de marche affiché = le plus proche.
  OFFICES: [
    { name: "Digital Value — 11 rue de la Chaussée d'Antin", lat: 48.8724951, lng: 2.3334064 }
  ],
  // Tags pratiques proposés à l'ajout d'un restaurant
  TAGS: ["Terrasse", "Végé-friendly", "Protéines", "Healthy", "Rapide", "Groupe 8+", "Grosses portions", "Délicieux"],
  // Repères de prix par personne (affichés en légende des symboles €)
  PRICE_INFO: { "€": "< 10", "€€": "10 – 15", "€€€": "15 – 25", "€€€€": "> 25" },
  // minutes = distance à vol d'oiseau × DETOUR ÷ vitesse de marche (m/min)
  WALK: { DETOUR: 1.3, SPEED: 80 },
  // Anneaux "min à pied" tracés autour du bureau
  RINGS_MIN: [5, 10, 15],
  // Périmètre autorisé pour l'ajout (région parisienne) — doit rester
  // synchronisé avec la contrainte SQL restaurants_zone_paris (05_geofence.sql)
  GEOFENCE: { latMin: 48.70, latMax: 49.05, lngMin: 2.10, lngMax: 2.60 }
};
