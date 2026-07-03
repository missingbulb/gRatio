# Pipeline vs ground truth — per-neuron report


## sample_01 — 4 neurons, segment 1260 ms

| neuron (pred~gt) | axon P | axon R | axon px (pred/gt) | myelin P | myelin R | myelin px (pred/gt) | g pred | g GT |
|---|---|---|---|---|---|---|---|---|
| #1 (p2~g2) | 0.97 | 0.97 | 105927/105942 | 0.84 | 0.94 | 150292/134188 | 0.64 | 0.66 |
| #2 (p4~g4) | 0.97 | 0.95 | 21792/22207 | 0.83 | 0.68 | 16901/20835 | 0.75 | 0.72 |
| #3 (p3~g3) | 0.90 | 0.98 | 19096/17649 | 0.97 | 0.65 | 33280/49764 | 0.60 | 0.51 |
| #4 (p1~g1) | 0.87 | 0.97 | 18225/16458 | 0.97 | 0.86 | 22687/25509 | 0.67 | 0.63 |

non-myelin pockets (sample): precision 0.90, recall 0.69 (pred 13414px / gt 17486px)

## sample_02 — 1 neurons, segment 952 ms

| neuron (pred~gt) | axon P | axon R | axon px (pred/gt) | myelin P | myelin R | myelin px (pred/gt) | g pred | g GT |
|---|---|---|---|---|---|---|---|---|
| #1 (p1~g1) | 0.99 | 0.97 | 232488/238367 | 0.89 | 0.98 | 258485/234946 | 0.69 | 0.71 |

## sample_03 — 5 neurons, segment 616 ms

| neuron (pred~gt) | axon P | axon R | axon px (pred/gt) | myelin P | myelin R | myelin px (pred/gt) | g pred | g GT |
|---|---|---|---|---|---|---|---|---|
| #1 (p1~g1) | 0.99 | 0.98 | 22064/22343 | 0.87 | 0.94 | 10737/9836 | 0.82 | 0.83 |
| #2 (p4~g4) | 0.96 | 0.99 | 24822/24259 | 0.96 | 0.65 | 9805/14437 | 0.85 | 0.79 |
| #3 (p3~g3) | 0.94 | 0.99 | 18354/17415 | 0.85 | 0.88 | 17263/16686 | 0.72 | 0.71 |
| #4 (p5~g5) | 0.99 | 0.94 | 17554/18362 | 0.78 | 0.95 | 24182/19813 | 0.65 | 0.69 |
| #5 (p2~g2) | 0.95 | 0.97 | 24231/23829 | 0.79 | 0.95 | 27863/23371 | 0.68 | 0.71 |
