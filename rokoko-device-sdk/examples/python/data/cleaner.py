
with open("testdata.csv", "a") as target:
    current = []

    for i in ['0','a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y']:
        with open(f"{i}.csv", "r") as f:
            l = f.readline()
            while l != "":
                try:
                    ar = l.split("\t")
                    ar.index("TRANSFORM")
                    ar.index("hub")
                    ar.index("default")
                    current.append((ar[1], ar[6].strip()))

                    if len(current) == 6:
                        current.sort(key=lambda x: x[0])
                        target.write(f"{i}," + ",".join(c[1] for c in current) + "\n")
                        current = []

                except ValueError:
                    pass
                l = f.readline()
