# Cellar Book — eigen website

Cellar Book als zelfstandige website: wijnvoorraad scannen, wijnkaart, etiketten, team en een
openbare webshop waar bestellingen de voorraad automatisch afboeken. Gebouwd zodat er later
meerdere kelders (andere restaurants) op kunnen draaien, elk volledig afgeschermd.

## Wat zit erin

| Map / bestand | Wat |
|---|---|
| `public/` | De website zelf (HTML, CSS, JavaScript — geen build-stap nodig) |
| `public/index.html` | Inloggen, account maken, kelder kiezen of aanmaken |
| `public/app.html` | De Cellar Book-app voor personeel |
| `public/shop.html?k=<naam>` | De openbare webshop van een kelder |
| `public/js/config.js` | **Hier vul je je Supabase-gegevens in** |
| `supabase/schema.sql` | De database: tabellen, toegangsregels, functies |
| `migratie/…json` | Je huidige 551 wijnen, klaar om te importeren |
| `tests/` | Automatische tests (alleen voor ontwikkelaars) |

## Kosten

- **Supabase** (database + inloggen + foto's): gratis tot 500 MB database en 1 GB opslag.
  Let op: een gratis project wordt gepauzeerd na 7 dagen zonder bezoek. Voor echt gebruik:
  Pro-abonnement, ca. $25/maand.
- **Vercel** (hosting): gratis voor persoonlijk gebruik (Hobby). Verkoop je het aan anderen,
  dan is het Pro-abonnement nodig (ca. $20/maand).
- **Eigen domeinnaam** (optioneel): ca. €10–15/jaar.

## Online zetten — stap voor stap (± 30 minuten)

### 1. Database (Supabase)
1. Maak een account op <https://supabase.com> en klik **New project**.
   Kies regio **West EU (Ireland)** of **Central EU (Frankfurt)** (AVG). Bewaar het databasewachtwoord.
2. Open **SQL Editor → New query**, plak de volledige inhoud van `supabase/schema.sql` en klik **Run**.
   Je moet "Success. No rows returned" zien.
3. Ga naar **Authentication → URL Configuration** en vul bij *Site URL* straks het adres van je
   website in (stap 3), bijvoorbeeld `https://cellarbook.vercel.app`. Zet hetzelfde adres ook bij
   *Redirect URLs*.
4. Ga naar **Project Settings → API** en kopieer:
   - *Project URL* (bijv. `https://abcd1234.supabase.co`)
   - *anon public* key

### 2. Gegevens invullen
Open `public/js/config.js` en vervang `YOUR-PROJECT…` en `YOUR-ANON-KEY` door de twee waarden
uit stap 1.4. (De anon key mag openbaar zijn: de toegangsregels in de database bepalen wie wat mag.)

### 3. Website (Vercel)
Makkelijkste route, zonder programmeerkennis:
1. Maak een account op <https://github.com>, maak een nieuwe (private) repository en upload
   de hele map (sleep de bestanden in de browser naar **Add file → Upload files**).
2. Maak een account op <https://vercel.com> met je GitHub-account, klik **Add New → Project**,
   kies de repository en klik **Deploy**. Instellingen hoef je niet te wijzigen
   (`vercel.json` regelt dat de map `public` online komt).
3. Je krijgt een adres zoals `https://cellarbook-xyz.vercel.app`. Vul dat in bij Supabase (stap 1.3).
4. Optioneel: koppel je eigen domein via Vercel → **Settings → Domains**.

Elke wijziging die je later naar GitHub uploadt, staat binnen een minuut automatisch online.

### 4. Eerste keer gebruiken
1. Open je website, klik **Create account**, bevestig via de e-mail en log in.
2. Maak je kelder aan (naam + webadres, bijv. `bokkedoorns`). Je bent nu eigenaar.
3. **Inventory → Import** → kies `migratie/cellar-book-backup-2026-10-16.json`.
   Je 551 wijnen en 1.652 flessen staan erin.
   *Tip:* werk je tot de overstap nog in de oude Cellar Book? Laat dan op de dag van overstap
   een nieuwe export maken, zodat de voorraad klopt.
4. **Settings → Webshop**: vul naam, contactgegevens en afhaalinfo in, zet de prijsfactor en
   zet **Shop is open for orders** aan. Deel de shoplink met je klanten.
5. **Settings → Team**: nodig medewerkers uit met hun e-mailadres. Zij maken een account met
   dat adres en krijgen automatisch toegang.

## Hoe de voorraad up-to-date blijft
- Scannen, bewerken en bestellingen gaan direct naar de database; iedereen die de app open heeft
  ziet wijzigingen live.
- Een webshopbestelling haalt de flessen meteen van de voorraad (gereserveerd). Annuleer je de
  bestelling in **Orders**, dan komen ze automatisch terug. Afgerond = de fles is weg.
- Twee mensen kunnen nooit tegelijk de laatste fles verkopen: de database controleert de
  voorraad bij elke scan en bestelling.

## Rollen
| | Eigenaar | Manager | Medewerker | Klant (shop) |
|---|---|---|---|---|
| In/uit scannen, bestellingen afhandelen | ✓ | ✓ | ✓ | – |
| Wijndetails, foto's | ✓ | ✓ | ✓ | – |
| Prijzen, voorraad corrigeren, import, verwijderen | ✓ | ✓ | – | – |
| Webshop-instellingen, team | ✓ | ✓ | – | – |
| Wijnen bekijken en bestellen | – | – | – | ✓ (zonder account) |

Klanten zien nooit inkoopprijzen, opslagplaatsen of andere kelders.

## Nog niet in deze versie (volgende stappen)
1. **Online betalen** (iDEAL via Mollie). Nu: betalen bij afhalen of per factuur.
2. **E-mailmelding** bij een nieuwe bestelling, en een bevestigingsmail naar de klant
   (Supabase Edge Function + een maildienst zoals Resend). Nu: melding in de app (tabblad Orders).
3. **Abonnementen** voor andere restaurants en een beheerscherm voor jou. Het aanmaken van een
   kelder staat nu voor iedereen met een account open; dat moet je afschermen vóór je het verkoopt.
4. **Juridisch voor verkoop**: algemene voorwaarden, privacyverklaring en verwerkersovereenkomst
   (AVG). Online alcohol verkopen vraagt een passende vergunning en leeftijdscontrole (de shop
   vraagt nu om een 18+-bevestiging).
5. Laat vóór verkoop een ontwikkelaar de beveiliging nalopen.

## Voor ontwikkelaars
- Database-tests: `tests/test_schema.sql` (draait tegen Postgres 16 met `tests/supabase_stub.sql`).
- Browser-tests: `python3 tests/test_ui.py` (Playwright; gebruikt `tests/mock-db.js` in plaats van Supabase).
- Alle Supabase-aanroepen staan in `public/js/db.js`.
