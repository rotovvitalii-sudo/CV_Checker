#!/usr/bin/env python3
"""
classify.py — словарь и правила отбора для Job Fit Search. Единственное место, где крутятся
критерии: fetch.py только тянет данные и зовёт classify().

Главный урок первого прогона (2026-10-02): нельзя искать термины по всему тексту вакансии.
Описания длинные, и «training program», «investment», «learning» встречаются в блоках бенефитов
и EEO — это давало фарму и страховые вместо EdTech. Поэтому сигнал взвешивается по месту:

  заголовок        — роль (короткий и точный, здесь решается поток A или B)
  компания + интро — домен (первые ~800 символов, это «about us», а не бенефиты)
  весь текст       — аудитория обучения: внешняя (клиенты, студенты) или внутренняя (сотрудники)
"""
import re

INTRO_CHARS = 800          # «about us» обычно в начале описания
MIN_SCORE = 4              # порог попадания в поток B

# ─── Ось 1: роль (только по заголовку) ───────────────────────────────────────
ROLE_PRODUCT = [           # поток A — продуктовое и бизнесовое лидерство
    r"head of product", r"product lead", r"lead product", r"director of product",
    r"principal product", r"staff product", r"senior product manager", r"product manager",
    r"product owner", r"group product", r"\bCPO\b", r"chief product", r"product marketing",
    r"growth (lead|manager|product)", r"business lead", r"country manager", r"general manager",
    r"head of (growth|edtech|education|learning|academy)", r"\bGM\b,",
]
ROLE_EDU_BUILDER = [       # поток B — тот, кто строит обучение
    r"instructional design", r"curriculum (lead|manager|designer|developer|specialist)",
    r"customer education", r"user education", r"course (producer|developer|creator)",
    r"education (content|manager|lead|director|specialist)",
    r"learning (experience|design|content|program)", r"\bLMS\b", r"learning management",
    r"training (manager|lead|director|program)", r"enablement (manager|lead|director)",
    r"head of (learning|education|training|enablement)", r"academy (manager|lead)",
    r"certification (manager|program)", r"student success",
]
# Задача обучения в самой вакансии — обязательна для потока A
EDU_TASK = [
    r"\bacademy\b", r"\bLMS\b", r"learning platform", r"learning management",
    r"customer education", r"user education", r"education[- ]led", r"\be-?learning\b",
    r"online (course|education|learning)", r"course (platform|catalog|creation|production)",
    r"certification program", r"training platform", r"educational content",
    r"onboarding (academy|university)", r"knowledge base", r"curriculum",
]

ROLE_TEACHING = [          # компания преподаёт сама: не вакансия для меня, не сигнал
    r"\bteacher\b", r"\btutor\b", r"\binstructor\b", r"\bfaculty\b", r"\bprofessor\b",
    r"teaching (expert|assistant)", r"\badjunct\b", r"\bgrader\b", r"\bcoach\b",
]

# ─── Ось 2: домен (компания + интро описания) ────────────────────────────────
DOMAINS = {
    "edtech": r"\bedtech\b|\be-?learning\b|online (course|education|learning|school)|"
              r"learning platform|education(al)? (platform|company|technology)|"
              r"\bbootcamp\b|\bupskilling\b|\bMOOC\b|test prep|tutoring (platform|marketplace)",
    "fintech_broker": r"\bbroker(age)?\b|online trading|\btrading (platform|app)\b|\bCFD\b|\bforex\b|"
                      r"\bfintech\b|investment (platform|app)|\bneobank\b|wealth (management|tech)|"
                      r"trading industry|financial markets",
    "crypto": r"\bcrypto(currency)?\b|\bweb3\b|\bblockchain\b|\bdefi\b|digital asset|\bexchange\b.{0,30}\b(crypto|token)",
}

# ─── Ось 3: кого учат ────────────────────────────────────────────────────────
AUDIENCE_EXTERNAL = [      # обучение как продукт: учим клиентов, пользователей, студентов
    r"customer education", r"user education", r"client (training|education)",
    r"partner (enablement|education|certification)", r"our (students|learners|users|customers)",
    r"course catalog", r"certification program", r"learner experience", r"student experience",
    r"education-led", r"academy for (customers|users|partners)", r"end users",
]
AUDIENCE_INTERNAL = [      # внутреннее обучение сотрудников: не наш случай
    r"our employees", r"new hires", r"internal training", r"employee (training|development|onboarding)",
    r"compliance training", r"safety training", r"staff development", r"\bHR\b (team|department)",
    r"onboarding (new )?(employees|staff|team members)",
]


# ─── Раздел «EdTech» (S6): какие роли в EdTech-компаниях показывать ─────────────
# В EdTech домен уже свой, поэтому задача обучения в тексте не нужна — отбор только по заголовку.
ROLE_GROWTH = [            # рост и маркетинг продукта
    r"\bgrowth\b", r"product marketing", r"\bPMM\b", r"lifecycle", r"head of marketing",
    r"marketing (director|lead)", r"(head|director|vp) of marketing", r"\bCMO\b", r"monetization", r"acquisition (lead|manager)",
]
ROLE_BUSINESS = [          # бизнес и рынки
    r"country manager", r"general manager", r"\bGM\b", r"business lead", r"head of (market|expansion|business|international)",
    r"(market|international) expansion", r"partnerships?", r"business development", r"commercial (lead|director|manager)",
    r"\bcountry lead\b", r"\bmarket lead\b", r"chief (business|commercial|operating) officer", r"\bCOO\b", r"\bCBO\b",
]
ROLE_OPS_EDU = [           # операции и контент-продукт обучения
    r"head of (operations|learning|education|academy|content|curriculum|customer education)",
    r"(director|lead) of (learning|education|content|curriculum|operations)",
    r"program manager", r"programme manager", r"customer education", r"academy (lead|manager|director)",
    r"learning experience", r"content (lead|director|strategy)", r"operations (lead|director|manager)",
]
EXCLUDE_LEVEL = [          # не уровень кандидата
    r"\bintern(ship)?\b", r"\bjunior\b", r"\bjr\.?\b", r"working student", r"\btrainee\b",
    r"\bassociate product manager\b", r"\bAPM\b", r"\bcoordinator\b", r"\bassistant\b",
    r"\bengineer(ing)?\b", r"\bdesigner\b", r"\bteacher\b", r"\btutor\b", r"\binstructor\b",
    # замер 2026-10-13 на 132 ролях 32 EdTech-компаний: шум не того уровня и профиля
    r"\brepresentative\b", r"\b[SB]DR\b", r"account executive", r"business development executive",
    r"\bspecialist\b", r"\bassociate\b(?! (director|vp|vice))", r"\bmentor\b", r"independent contractor",
    r"\bcounsel\b", r"\blegal\b", r"\battorney\b", r"\bscientist\b", r"\banalyst\b", r"\bresearcher\b",
    r"talent acquisition", r"\brecruit", r"technical program manager", r"\bTPM\b", r"locali[sz]ation",
    r"(influencer|performance|brand|field|content|social media|seo|affiliate|event) marketing", r"copywriter",
]
# Порядок важен только для метки: ROLE_PRODUCT шире и включает «head of growth», «country manager»
EDTECH_GROUPS = [("growth", ROLE_GROWTH), ("business", ROLE_BUSINESS), ("product", ROLE_PRODUCT), ("ops", ROLE_OPS_EDU)]


def edtech_role(title):
    """Группа роли для раздела EdTech (product / growth / business / ops) или None."""
    if any(re.search(p, title, re.I) for p in EXCLUDE_LEVEL):
        return None
    for group, pats in EDTECH_GROUPS:
        if any(re.search(p, title, re.I) for p in pats):
            return group
    return None


# ─── Раздел «FinTech» (S7): плюс группа «обучение клиентов» ─────────────────────
# Финтех, который строит обучение клиентов, — самый сильный паттерн кандидата (так случались его прошлые наймы).
ROLE_EDU_CLIENT = [
    r"customer education", r"client education", r"user education", r"investor education",
    r"(trading|financial|crypto|market) education", r"education (lead|manager|director|content|program)",
    r"\bacademy\b", r"head of (learning|education)", r"(learning|education) (lead|director|manager)",
    r"instructional design(er)? (lead|manager)", r"lead instructional design", r"learning experience",
]
# Для этой группы «designer» не повод отсеять (Lead Instructional Designer), остальные исключения — те же
EXCLUDE_EDU = [p for p in EXCLUDE_LEVEL if "designer" not in p]


# В финтехе «операции» и «бизнес» часто означают риск, комплаенс и инженерные роли — это не фит
EXCLUDE_FIN = [r"\bcompliance\b", r"\brisk\b", r"\bincident", r"\berm\b", r"\baml\b", r"\bkyc\b",
    r"\bliquidity\b", r"\bcontrols?\b", r"\bfrontend\b", r"\bbackend\b", r"\bfraud\b", r"\btreasury\b",
    r"\bregulatory\b", r"\blegal\b", r"\baudit"]


def fintech_role(title):
    """Группа роли для раздела FinTech: edu (обучение клиентов) первой, дальше — как в EdTech."""
    if any(re.search(p, title, re.I) for p in ROLE_EDU_CLIENT) and not any(re.search(p, title, re.I) for p in EXCLUDE_EDU):
        return "edu"
    if any(re.search(p, title, re.I) for p in EXCLUDE_FIN):
        return None
    return edtech_role(title)


# ─── Только США: переезд в Штаты или резидентство как условие работы (2026-10-26) ──
# Вакансия отсеивается, если ВСЕ её локации в США, или в тексте прямо требуется право работать / жить в США,
# а других (не американских) локаций нет. «Remote - Global», «London; New York», «Americas» — остаются.
US_STATES = ("alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|"
             "illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|"
             "mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|"
             "north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|"
             "south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming")
US_CODES = ("AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|"
            "NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC")
US_CITIES = ("new york|nyc|san francisco|sf bay|bay area|menlo park|palo alto|mountain view|san jose|los angeles|"
             "seattle|chicago|boston|austin|denver|atlanta|miami|dallas|houston|philadelphia|crystal city|"
             "washington,? d\.?c|silicon valley|brooklyn|santa monica|salt lake city|portland|raleigh|nashville|"
             "east coast|west coast|pacific time|eastern time")
US_LOC = re.compile(rf"\b(united states|usa|u\.s\.a?\.?|us|{US_STATES}|{US_CITIES})\b|^\s*({US_CODES})\b", re.I)
US_TAIL = re.compile(rf"(united states( of america)?|usa|u\.s\.a?\.?|us|{US_STATES}|{US_CODES})", re.I)
GENERIC_LOC = re.compile(r"\b(remote|hybrid|on-?site|office|headquarters|hq|anywhere|full[- ]time|time zone|"
                         r"zone|only|based|roles?|or|and|in)\b|[-–—()/|:.]", re.I)
US_WORK_REQ = re.compile(
    r"(authori[sz]ed to work in the (united states|u\.?s\.?a?)\b|(requires?|required|must have) (united states|u\.?s\.?) work authori[sz]ation|"
    r"(united states|u\.?s\.?) work authori[sz]ation (is )?required|must be a (united states|u\.?s\.?) citizen|"
    r"(united states|u\.?s\.?) citizenship (is )?required|(united states|u\.?s\.?) (persons?|residents?) only|(must|need to|required to|should) (be )?(reside|live|located|based) in the (united states|u\.?s\.?)|"
    r"(reside|resident|located|based) in the (united states|u\.?s\.?)( only)?\b.{0,40}(required|only|must)|"
    r"(must|need to) (relocate|move) to the (united states|u\.?s\.?)|open to (candidates|applicants) (located|based) in the u\.?s)",
    re.I)


def us_only(job):
    """Причина («все локации в США» / «требуется право работать в США») или None."""
    # Локации через «;» и «|». «Lake Mary, FL», «Austin, Texas», «…, United States» — место в США целиком (последняя часть —
    # штат или страна). Иначе делим по запятой: «Toronto, Winnipeg» и длинный список стран — не только США
    us = non_us = 0
    parts = []
    for seg in [x.strip() for x in re.split(r";|\s\|\s", job.get("location", "") or "") if x.strip()]:
        tail = seg.rsplit(",", 1)[-1].strip() if "," in seg else ""
        if tail and US_TAIL.fullmatch(GENERIC_LOC.sub(" ", tail).strip()):
            us += 1
        else:
            parts += [x.strip() for x in seg.split(",") if x.strip()]
    for p in parts:
        # Что остаётся без американских мест и служебных слов: «London» в «New York or London» — уже не только США
        rest = GENERIC_LOC.sub(" ", US_LOC.sub(" ", p)).strip()
        if rest:
            non_us += 1          # Лондон, EMEA, Global, Americas, любая другая страна — не только США
        elif US_LOC.search(p):
            us += 1
    if non_us:
        return None
    if us:
        return "все локации в США"
    if US_WORK_REQ.search(job.get("description", "") or ""):
        return "требуется право работать / жить в США"
    return None


def _hits(patterns, text):
    return sorted({m.group(0).lower() for p in patterns for m in [re.search(p, text, re.I)] if m})


def classify(job):
    """
    Возвращает dict: bucket (A/B/None), score и причины — чтобы было видно, почему вакансия прошла.

    Поток A — продуктовая/бизнес-роль, где В САМОЙ ВАКАНСИИ есть задача про обучение.
              Без этого это «просто продакт в финтехе», а не фит.

    Поток B — компания нанимает того, кто СТРОИТ обучение. Ключевая инверсия (урок 2026-10-02):
              EdTech, нанимающий инструкционного дизайнера, — это его обычная работа, продакты
              у него уже есть. Сильный сигнал — когда обучение начинает строить НЕ образовательная
              компания: брокер, финтех, крипто, SaaS. Это ровно паттерн прошлых наймов кандидата.
    """
    title = job.get("title", "")
    intro = f"{job.get('company','')} {job.get('description','')[:INTRO_CHARS]}"
    full = f"{title} {job.get('description','')}"

    role_product = _hits(ROLE_PRODUCT, title)
    role_builder = _hits(ROLE_EDU_BUILDER, title)
    role_teaching = _hits(ROLE_TEACHING, title)

    domains = [d for d, pat in DOMAINS.items() if re.search(pat, intro, re.I)]
    is_edtech = "edtech" in domains
    target_domain = [d for d in domains if d != "edtech"]      # финтех, брокеры, крипто
    edu_task = _hits(EDU_TASK, full)
    external = _hits(AUDIENCE_EXTERNAL, full)
    internal = _hits(AUDIENCE_INTERNAL, full)

    # Преподаватели — ни вакансия, ни сигнал: школа нанимает учителей, это её обычная работа
    if role_teaching and not (role_product or role_builder):
        return {"bucket": None, "score": 0, "domains": domains, "role_product": role_product,
                "role_builder": role_builder, "role_teaching": role_teaching,
                "edu_task": edu_task, "external": external, "internal": internal,
                "why_not": "преподавательская роль"}

    score = 0
    if role_product:
        score += 2
    if role_builder:
        score += 2
    if edu_task:
        score += 2
    if external:
        score += 2
    if target_domain:
        score += 3                       # брокер/финтех/крипто, который берётся за обучение
    elif is_edtech:
        score += 1                       # EdTech: домен свой, но обучение для него не новость
    if internal and not external:
        score -= 2                       # учат своих сотрудников — мимо

    bucket = None
    if role_product and edu_task and (domains or external):
        bucket = "A"
    elif role_builder and not is_edtech and score >= MIN_SCORE:
        bucket = "B"                     # главный сигнал: обучение строит не-образовательная компания
    elif role_builder and is_edtech and score >= MIN_SCORE + 2:
        bucket = "B"                     # EdTech попадает только с сильным перевесом

    return {"bucket": bucket, "score": score, "domains": domains,
            "role_product": role_product, "role_builder": role_builder,
            "role_teaching": role_teaching, "edu_task": edu_task,
            "external": external, "internal": internal, "why_not": ""}
