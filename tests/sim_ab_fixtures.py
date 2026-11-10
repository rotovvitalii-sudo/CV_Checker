"""C22: эталон статистики симулятора A/B — stdlib statistics.NormalDist (без scipy).
Пишет tests/fixtures/sim_ab.json; проверка движка — `node tests/sim-ab.test.js`."""
import json, math, random
from statistics import NormalDist
N = NormalDist()
random.seed(22)
out = {"prop": [], "size": [], "srm": []}
for _ in range(20):
    nA, nB = random.randint(800, 120000), random.randint(800, 120000)
    pA = random.uniform(0.01, 0.3); pB = pA * random.uniform(0.85, 1.2)
    xA, xB = round(nA * pA), round(nB * pB)
    a, b = xA / nA, xB / nB
    pp = (xA + xB) / (nA + nB)
    sp = math.sqrt(pp * (1 - pp) * (1 / nA + 1 / nB)); se = math.sqrt(a * (1 - a) / nA + b * (1 - b) / nB)
    z = (b - a) / sp; zc = N.inv_cdf(0.975)
    out["prop"].append({"in": [nA, xA, nB, xB], "p": 2 * (1 - N.cdf(abs(z))), "lo": b - a - zc * se, "hi": b - a + zc * se})
for _ in range(20):
    base = random.uniform(0.005, 0.3); mde = random.choice([0.02, 0.05, 0.1, 0.2]); alpha = random.choice([0.01, 0.05, 0.1]); power = random.choice([0.8, 0.9])
    p2 = base * (1 + mde)
    n = (N.inv_cdf(1 - alpha / 2) + N.inv_cdf(power)) ** 2 * (base * (1 - base) + p2 * (1 - p2)) / (p2 - base) ** 2
    out["size"].append({"in": {"type": "prop", "base": base, "mde": mde, "alpha": alpha, "power": power}, "n": math.ceil(n)})
for _ in range(10):
    nA, nB = random.randint(1000, 100000), random.randint(1000, 100000); s = random.choice([0.5, 0.2, 0.1])
    n = nA + nB; chi = (nA - n * (1 - s)) ** 2 / (n * (1 - s)) + (nB - n * s) ** 2 / (n * s)
    out["srm"].append({"in": [nA, nB, s], "p": 2 * (1 - N.cdf(math.sqrt(chi)))})
json.dump(out, open("tests/fixtures/sim_ab.json", "w"), indent=1)
print("fixtures:", {k: len(v) for k, v in out.items()})
