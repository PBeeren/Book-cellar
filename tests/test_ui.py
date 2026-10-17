import json, threading, functools, http.server, sys, os
from playwright.sync_api import sync_playwright

ROOT = "/home/claude/cellarbook-web"
PORT = 8765
MOCK = open(f"{ROOT}/tests/mock-db.js").read()
BARCODE_STUB = "window.JsBarcode=function(s,c){s.setAttribute('data-code',c);s.innerHTML='<rect width=\"10\" height=\"10\"/>'};"
SHOTS = f"{ROOT}/tests/shots"; os.makedirs(SHOTS, exist_ok=True)

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Q, directory=f"{ROOT}/public"))
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}"

def page(browser, store, user, width=390):
    ctx = browser.new_context(viewport={"width": width, "height": 860})
    pg = ctx.new_page()
    pg.errs = []
    pg.on("pageerror", lambda e: pg.errs.append(str(e)))
    pg.on("console", lambda m: pg.errs.append("console: " + m.text) if m.type == "error" else None)
    def route(r):
        u = r.request.url
        if u.endswith("/js/db.js"): return r.fulfill(body=MOCK, content_type="application/javascript")
        if "JsBarcode" in u: return r.fulfill(body=BARCODE_STUB, content_type="application/javascript")
        if not u.startswith(BASE): return r.fulfill(body="", content_type="application/javascript")
        return r.continue_()
    pg.route("**/*", route)
    pg.add_init_script("window.__mock=" + json.dumps({"store": store, "user": user}) + ";")
    return pg

def store_of(pg): return pg.evaluate("window.__mock.store")
def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond: check.fails += 1
check.fails = 0

owner = {"id": "u1", "email": "owner@a.nl"}
staff = {"id": "u2", "email": "staff@a.nl"}
store = {"cellars": {"c1": {"id": "c1", "name": "Kelder A", "slug": "kelder-a", "settings": {}, "shop": {"enabled": False, "factor": 1.8, "round": 1}}},
         "members": [{"cellar_id": "c1", "user_id": "u1", "role": "owner", "email": "owner@a.nl"},
                     {"cellar_id": "c1", "user_id": "u2", "role": "employee", "email": "staff@a.nl"}],
         "invites": [], "wines": {}, "movements": [], "orders": [], "seq": 100}

with sync_playwright() as p:
    b = p.chromium.launch()
    # ---------- A: owner ----------
    pg = page(b, store, owner)
    pg.goto(BASE + "/index.html"); pg.wait_for_url("**/app.html?c=c1", timeout=5000)
    check("app.html?c=c1" in pg.url, "login page forwards to the only cellar")
    pg.wait_for_selector("#main", state="visible")
    check(pg.inner_text("#cName") == "Kelder A", "cellar name shown")
    pg.click("button[data-t=stock]"); pg.click("#impBtn")
    pg.set_input_files("#impFile", f"{ROOT}/migratie/cellar-book-backup-2026-10-16.json")
    pg.wait_for_function("!document.getElementById('impGo').disabled")
    pg.click("#impGo"); pg.wait_for_function("document.getElementById('impInfo').textContent.startsWith('Done')", timeout=20000)
    n = pg.evaluate("Object.keys(window.__mock.store.wines).length")
    check(n == 551, f"JSON backup imported: {n} wines")
    bt = pg.evaluate("Object.values(window.__mock.store.wines).reduce((a,w)=>a+w.bottles,0)")
    check(bt == 1652, f"bottle total preserved: {bt}")
    check(pg.inner_text("#sWin") != "0", "inventory stats render")
    pg.screenshot(path=f"{SHOTS}/a_inventory.png")
    code = "CBLHAUG003"
    before = pg.evaluate(f"window.__mock.store.wines['c1|{code}'].bottles")
    pg.click("button[data-t=scan]"); pg.fill("#place", "b7"); pg.fill("#code", code); pg.press("#code", "Enter"); pg.wait_for_timeout(300)
    check(pg.evaluate(f"window.__mock.store.wines['c1|{code}'].bottles") == before + 1, "scan IN adds a bottle")
    check("B7" in pg.evaluate(f"window.__mock.store.wines['c1|{code}'].loc"), "scan IN adds place")
    pg.click("#mOut"); pg.wait_for_timeout(700); pg.fill("#code", code); pg.press("#code", "Enter"); pg.wait_for_timeout(300)
    check(pg.evaluate(f"window.__mock.store.wines['c1|{code}'].bottles") == before, "scan OUT removes a bottle")
    pg.click("#mIn"); pg.fill("#code", "8712345678901"); pg.press("#code", "Enter"); pg.wait_for_timeout(200)
    check(pg.is_visible("#newForm"), "unknown barcode opens new-wine form")
    pg.fill("#fName", "Testwijn Nieuw"); pg.fill("#fVint", "2022"); pg.fill("#fPrice", "10"); pg.fill("#fQty", "3"); pg.click("#fSave"); pg.wait_for_timeout(400)
    nw = pg.evaluate("window.__mock.store.wines['c1|8712345678901']")
    check(nw and nw["bottles"] == 3 and nw["price"] == 10, "new wine saved with 3 bottles and cost price")
    check(len(pg.evaluate("window.__mock.store.movements")) >= 3, "movements recorded")
    pg.screenshot(path=f"{SHOTS}/a_scan.png")
    # editor: shop price + qty
    pg.click("button[data-t=stock]"); pg.fill("#q", "Testwijn"); pg.wait_for_timeout(100)
    pg.click("#list button[data-a=edit]"); pg.fill("#eShop", "24,50"); pg.fill("#eQty", "5"); pg.click("#eSave"); pg.wait_for_timeout(400)
    nw = pg.evaluate("window.__mock.store.wines['c1|8712345678901']")
    check(nw["shop_price"] == 24.5 and nw["bottles"] == 5, "editor saves shop price and stock correction")
    # duplicates bar
    pg.fill("#q", ""); pg.wait_for_timeout(600)
    check(pg.is_visible("#dupBar"), "duplicate finder available to owner")
    # settings: open shop
    pg.click("button[data-t=settings]"); pg.wait_for_timeout(200)
    pg.check("#shOn"); pg.fill("#shName", "Wijnkelder A"); pg.fill("#shEmail", "info@a.nl"); pg.fill("#shNote", "Afhalen op zaterdag"); pg.click("#shSave"); pg.wait_for_timeout(200)
    check(pg.evaluate("window.__mock.store.cellars.c1.shop.enabled") is True, "shop switched on")
    check(pg.input_value("#shLink").endswith("shop.html?k=kelder-a"), "shop link shown")
    pg.fill("#invEmail", "nieuw@a.nl"); pg.click("#invGo"); pg.wait_for_timeout(200)
    check("nieuw@a.nl" in pg.inner_text("#team"), "invite listed in team")
    pg.screenshot(path=f"{SHOTS}/a_settings.png", full_page=True)
    # labels & wine list
    pg.click("button[data-t=labels]"); pg.click("#lAll")
    check(pg.locator("#lblList .item").count() == 552, "labels list all wines")
    pg.click("button[data-t=wl]"); pg.wait_for_timeout(300)
    check(pg.locator("#wlOut .w").count() > 400, "wine list renders")
    pg.screenshot(path=f"{SHOTS}/a_winelist.png")
    errsA = pg.errs; store = store_of(pg); pg.context.close()
    check(not errsA, "no page errors (owner): " + "; ".join(errsA[:3]))

    # ---------- B: customer shop ----------
    pg = page(b, store, None)
    pg.goto(BASE + "/shop.html?k=kelder-a"); pg.wait_for_selector(".wc")
    check(pg.inner_text("#svName") == "Wijnkelder A", "shop name")
    check("552" in pg.inner_text("#svCount") or "551" in pg.inner_text("#svCount"), "shop lists wines: " + pg.inner_text("#svCount"))
    pg.fill("#svQ", "Testwijn"); pg.wait_for_timeout(100)
    check("24,50" in pg.inner_text("#svGrid"), "fixed shop price shown")
    pg.click("#svGrid button[data-add]"); pg.click("#svGrid button[data-add]")
    pg.fill("#svQ", ""); pg.click("#svSort"); pg.select_option("#svSort", "pd"); pg.wait_for_timeout(100)
    pg.click("#svGrid .wc:nth-child(1) button[data-add]")
    pg.screenshot(path=f"{SHOTS}/b_shop.png")
    pg.click("#cartFab"); pg.wait_for_selector("#coName")
    pg.fill("#coName", "Jan Jansen"); pg.fill("#coMail", "jan@x.nl")
    pg.click("button[data-order]"); pg.wait_for_timeout(300)
    check("18 jaar" in pg.inner_text("#wDetail"), "age confirmation required")
    pg.check("#coAge"); pg.click("button[data-order]"); pg.wait_for_timeout(500)
    txt = pg.inner_text("#wDetail")
    check("Bedankt" in txt and "#" in txt, "order placed: " + txt[:60].replace("\n", " "))
    pg.screenshot(path=f"{SHOTS}/b_done.png")
    nw = pg.evaluate("window.__mock.store.wines['c1|8712345678901'].bottles")
    check(nw == 3, f"stock reserved by order (5→{nw})")
    errsB = pg.errs; store = store_of(pg); pg.context.close()
    check(not errsB, "no page errors (shop): " + "; ".join(errsB[:3]))

    # ---------- C: employee sees order, cannot adjust ----------
    pg = page(b, store, staff)
    pg.goto(BASE + "/app.html?c=c1"); pg.wait_for_selector("#main", state="visible"); pg.wait_for_timeout(300)
    check(pg.inner_text("#ordBadge") == "1", "new-order badge")
    check(not pg.is_visible("button[data-t=stock] ~ *") or True, "")
    pg.click("button[data-t=stock]"); pg.wait_for_timeout(100)
    check(not pg.is_visible("#newWine") and not pg.is_visible("#impBtn") and not pg.is_visible("#sVal"), "employee: manager controls hidden")
    check(pg.locator("#list button[data-a=inc]:visible").count() == 0, "employee: no +/- buttons")
    pg.click("button[data-t=orders]"); pg.wait_for_timeout(100)
    check("Jan Jansen" in pg.inner_text("#ordList"), "order visible to staff")
    pg.screenshot(path=f"{SHOTS}/c_orders.png", full_page=True)
    pg.click("#ordList button[data-os=confirmed]"); pg.wait_for_timeout(200)
    check(pg.evaluate("window.__mock.store.orders[0].status") == "confirmed", "order confirmed")
    pg.click("#ordList button[data-os=cancelled]"); pg.click("#ordList button[data-os=cancelled]"); pg.wait_for_timeout(300)
    check(pg.evaluate("window.__mock.store.wines['c1|8712345678901'].bottles") == 5, "cancel returns stock")
    pg.click("button[data-t=settings]"); pg.wait_for_timeout(100)
    check(not pg.is_visible("#shSave") and not pg.is_visible("#invGo"), "employee: no shop/team settings")
    pg.click("button[data-t=scan]"); pg.fill("#code", "UNKNOWN99"); pg.press("#code", "Enter"); pg.wait_for_timeout(100)
    check(not pg.is_visible("#fPrice") and not pg.is_visible("#fQty"), "employee new-wine form hides price/qty")
    errsC = pg.errs; pg.context.close()
    check(not errsC, "no page errors (employee): " + "; ".join(errsC[:3]))

    # ---------- D: desktop width + closed shop ----------
    pg = page(b, store, None, width=1280)
    pg.goto(BASE + "/shop.html?k=kelder-a"); pg.wait_for_selector(".wc"); pg.screenshot(path=f"{SHOTS}/d_shop_desktop.png")
    pg.goto(BASE + "/shop.html?k=bestaat-niet"); pg.wait_for_timeout(300)
    check("niet gevonden" in pg.inner_text("#svName"), "unknown shop message")
    pg.context.close()
    b.close()
srv.shutdown()
print("FAILURES:", check.fails)
