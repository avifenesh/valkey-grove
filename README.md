# Valkey Grove

A fractal map of a real Valkey cluster. Each primary grows a tree. Hash slots determine the branches; real keys form the leaves.

## Run the local grove

Requires Go 1.23+, Python 3, `valkey-server` and `valkey-cli` on Linux.

```sh
python3 scripts/local-cluster.py up
```

Open **http://127.0.0.1:4187**. This starts six dedicated Valkey primaries on ports 7400–7405, assigns all 16,384 slots, and seeds 12,000 sample keys. It leaves an existing service on port 6379 alone. The sample cluster has no replicas or persistence and is for local exploration.

```sh
python3 scripts/local-cluster.py stop
```

Configuration and logs stay under `.local/`. `up` restores the sample dataset after a stop. `start`, `seed` and `serve` can also run separately.

## Use another cluster

```sh
go run . -cluster host:6379
# For TLS:
go run . -cluster host:6379 -tls
```

Set `VALKEY_USERNAME` and `VALKEY_PASSWORD` in your environment when authentication is required. Credentials are never sent to the browser. Node addresses returned by `CLUSTER SLOTS` must be reachable from the collector. TLS validates certificates using the system trust store.

The collector reads `CLUSTER SLOTS`, `DBSIZE` and `SCAN` from database 0. It does not read values or write to a cluster. The frontend refreshes every eight seconds while visible. A five-second cache combines repeated requests. `-sample 24000` bounds scan work and browser memory; the budget is shared equally across primaries. `DBSIZE` supplies the full key count. Scanning is not atomic and is not a statistically uniform sample. An unavailable node is marked offline, and partial data is labeled as such. The whole collection has a 15-second deadline. Binary names are preserved as base64 with their slot computed from the original bytes.

The local HTTP server binds to loopback, rejects foreign Host and Origin headers, and does not enable CORS. A remote hosted browser cannot directly connect to this local collector.

## Explore

- Select a primary to isolate its branches.
- Search a key name to trace its slot and node. A missing sampled key is shown as a calculated location, not proof that the key exists.
- Click a dot to inspect the observed key. Binary names are labeled as base64.
- Change branch spread or recursion depth; drag and zoom the canvas.
- Switch light/dark themes or pause motion. Reduced motion is respected.
- Save the artwork as PNG or export a JSON snapshot. Snapshots contain key names and node addresses; they stay local until you choose to share them.

The hosted edition opens a saved capture of this development cluster and supports local snapshot imports. It is labeled **Saved snapshot**. Use the local app for live data. Imported data is processed in the browser and is not uploaded.

## Validate

```sh
GROVE_TEST_PORT=7400 go test -race ./...
GROVE_TEST_PORT=7400 node --test test/*.test.mjs
go vet ./...
```

The tests compare text, Unicode, empty keys, and hash tags with a real Valkey cluster. A collector integration test writes and removes one temporary binary key in the dedicated test cluster and verifies its identity and slot survive JSON transport. HTTP tests cover the local access boundary and connection failure.

No frontend build step or runtime npm dependencies. `go build -o grove .` embeds `dist/` in the Go binary. Rebuild and restart after frontend edits. The visualization uses deterministic recursive geometry; CRC16/XMODEM and hash-tag rules follow the [Valkey cluster specification](https://valkey.io/topics/cluster-spec/).
