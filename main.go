package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

//go:embed dist/*
var assets embed.FS

type Node struct {
	ID       string   `json:"id"`
	Address  string   `json:"address"`
	Slots    [][2]int `json:"slots"`
	Keys     int64    `json:"keys"`
	Replicas int      `json:"replicas"`
	Error    string   `json:"error,omitempty"`
}
type Key struct {
	Name     string `json:"name"`
	Node     int    `json:"node"`
	Slot     int    `json:"slot"`
	Encoding string `json:"encoding,omitempty"`
}

func keySlot(key string) int {
	if start := strings.IndexByte(key, '{'); start >= 0 {
		if end := strings.IndexByte(key[start+1:], '}'); end > 0 {
			key = key[start+1 : start+1+end]
		}
	}
	var crc uint16
	for i := 0; i < len(key); i++ {
		crc ^= uint16(key[i]) << 8
		for bit := 0; bit < 8; bit++ {
			if crc&0x8000 != 0 {
				crc = (crc << 1) ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	return int(crc & 16383)
}

func snapshotKey(name string, node int) Key {
	k := Key{Name: name, Node: node, Slot: keySlot(name)}
	if !utf8.ValidString(name) {
		k.Name = base64.StdEncoding.EncodeToString([]byte(name))
		k.Encoding = "base64"
	}
	return k
}

type Snapshot struct {
	Nodes       []Node `json:"nodes"`
	Keys        []Key  `json:"keys"`
	CapturedAt  string `json:"capturedAt"`
	Source      string `json:"source"`
	SampleLimit int    `json:"sampleLimit"`
	Complete    bool   `json:"complete"`
}
type Collector struct {
	Address string
	TLS     bool
	Limit   int
	mu      sync.Mutex
	cached  Snapshot
	last    time.Time
}
type respConn struct {
	net.Conn
	reader *bufio.Reader
}

func readRESP(r *bufio.Reader, depth int) (any, error) {
	if depth > 16 {
		return nil, errors.New("RESP nesting too deep")
	}
	line, err := r.ReadString('\n')
	if err != nil {
		return nil, err
	}
	if len(line) < 3 || !strings.HasSuffix(line, "\r\n") {
		return nil, errors.New("invalid RESP line")
	}
	body := line[1 : len(line)-2]
	switch line[0] {
	case '+':
		return body, nil
	case '-':
		return nil, errors.New(body)
	case ':':
		return strconv.ParseInt(body, 10, 64)
	case '$':
		n, e := strconv.Atoi(body)
		if e != nil || n < -1 || n > 64<<20 {
			return nil, errors.New("invalid bulk length")
		}
		if n == -1 {
			return nil, nil
		}
		b := make([]byte, n+2)
		if _, e = io.ReadFull(r, b); e != nil {
			return nil, e
		}
		if string(b[n:]) != "\r\n" {
			return nil, errors.New("invalid bulk terminator")
		}
		return string(b[:n]), nil
	case '*':
		n, e := strconv.Atoi(body)
		if e != nil || n < -1 || n > 1<<20 {
			return nil, errors.New("invalid array length")
		}
		if n == -1 {
			return nil, nil
		}
		a := make([]any, n)
		for i := range a {
			a[i], e = readRESP(r, depth+1)
			if e != nil {
				return nil, e
			}
		}
		return a, nil
	}
	return nil, errors.New("unsupported RESP response")
}
func (c *respConn) command(args ...string) (any, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "*%d\r\n", len(args))
	for _, a := range args {
		fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(a), a)
	}
	if _, err := io.WriteString(c.Conn, b.String()); err != nil {
		return nil, err
	}
	return readRESP(c.reader, 0)
}
func (c *Collector) dial(ctx context.Context, address string) (*respConn, error) {
	d := net.Dialer{Timeout: 3 * time.Second}
	var conn net.Conn
	var err error
	if c.TLS {
		td := tls.Dialer{NetDialer: &d, Config: &tls.Config{MinVersion: tls.VersionTLS12}}
		conn, err = td.DialContext(ctx, "tcp", address)
	} else {
		conn, err = d.DialContext(ctx, "tcp", address)
	}
	if err != nil {
		return nil, err
	}
	deadline, _ := ctx.Deadline()
	conn.SetDeadline(deadline)
	r := &respConn{conn, bufio.NewReader(conn)}
	if password := os.Getenv("VALKEY_PASSWORD"); password != "" {
		args := []string{"AUTH"}
		if user := os.Getenv("VALKEY_USERNAME"); user != "" {
			args = append(args, user)
		}
		args = append(args, password)
		if _, err = r.command(args...); err != nil {
			conn.Close()
			return nil, errors.New("Valkey authentication failed")
		}
	}
	return r, nil
}
func (c *Collector) collect(ctx context.Context) (Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.last) < 5*time.Second {
		return c.cached, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	seed, err := c.dial(ctx, c.Address)
	if err != nil {
		return Snapshot{}, fmt.Errorf("connect to cluster: %w", err)
	}
	defer seed.Close()
	raw, err := seed.command("CLUSTER", "SLOTS")
	if err != nil {
		return Snapshot{}, fmt.Errorf("read cluster topology: %w", err)
	}
	ranges, ok := raw.([]any)
	if !ok {
		return Snapshot{}, errors.New("invalid CLUSTER SLOTS response")
	}
	s := Snapshot{Nodes: []Node{}, Keys: []Key{}, CapturedAt: time.Now().UTC().Format(time.RFC3339), Source: "live", SampleLimit: c.Limit, Complete: true}
	byID := map[string]int{}
	for _, entry := range ranges {
		row, ok := entry.([]any)
		if !ok || len(row) < 3 {
			return s, errors.New("invalid slot range")
		}
		a, aok := row[0].(int64)
		b, bok := row[1].(int64)
		primary, pok := row[2].([]any)
		if !aok || !bok || !pok || len(primary) < 3 {
			return s, errors.New("invalid primary")
		}
		host, _ := primary[0].(string)
		port, _ := primary[1].(int64)
		id, _ := primary[2].(string)
		if host == "" {
			host, _, _ = net.SplitHostPort(c.Address)
		}
		address := net.JoinHostPort(host, strconv.FormatInt(port, 10))
		if id == "" {
			id = address
		}
		i, exists := byID[id]
		if !exists {
			i = len(s.Nodes)
			byID[id] = i
			s.Nodes = append(s.Nodes, Node{ID: id, Address: address, Slots: [][2]int{}, Replicas: len(row) - 3})
		}
		s.Nodes[i].Slots = append(s.Nodes[i].Slots, [2]int{int(a), int(b)})
	}
	sort.Slice(s.Nodes, func(i, j int) bool { return s.Nodes[i].Slots[0][0] < s.Nodes[j].Slots[0][0] })
	for i := range s.Nodes {
		n := &s.Nodes[i]
		conn, e := c.dial(ctx, n.Address)
		if e != nil {
			n.Error = "Node connection failed"
			s.Complete = false
			continue
		}
		count, e := conn.command("DBSIZE")
		if e != nil {
			n.Error = "DBSIZE failed"
			s.Complete = false
			conn.Close()
			continue
		}
		n.Keys, _ = count.(int64)
		budget := c.Limit / len(s.Nodes)
		if i < c.Limit%len(s.Nodes) {
			budget++
		}
		seen := map[string]bool{}
		cursor := "0"
		for len(seen) < budget {
			v, e := conn.command("SCAN", cursor, "COUNT", "512")
			if e != nil {
				n.Error = "Key scan failed"
				s.Complete = false
				break
			}
			page, ok := v.([]any)
			if !ok || len(page) != 2 {
				n.Error = "Invalid SCAN response"
				s.Complete = false
				break
			}
			cursor, ok = page[0].(string)
			names, nok := page[1].([]any)
			if !ok || !nok {
				n.Error = "Invalid SCAN page"
				s.Complete = false
				break
			}
			for _, item := range names {
				key, ok := item.(string)
				if ok && !seen[key] && len(seen) < budget {
					seen[key] = true
					s.Keys = append(s.Keys, snapshotKey(key, i))
				}
			}
			if cursor == "0" {
				break
			}
		}
		conn.Close()
	}
	c.cached = s
	c.last = time.Now()
	return s, nil
}
func handler(c *Collector) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/snapshot", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		s, e := c.collect(r.Context())
		if e != nil {
			w.WriteHeader(502)
			json.NewEncoder(w).Encode(map[string]string{"error": e.Error()})
			return
		}
		json.NewEncoder(w).Encode(s)
	})
	root, _ := fs.Sub(assets, "dist")
	mux.Handle("/", http.FileServer(http.FS(root)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil {
			host = r.Host
		}
		if host != "localhost" && host != "127.0.0.1" && host != "::1" {
			http.Error(w, "Local access only", 403)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host {
			http.Error(w, "Same-origin access only", 403)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		mux.ServeHTTP(w, r)
	})
}
func main() {
	address := flag.String("cluster", "127.0.0.1:7400", "Valkey seed address")
	listen := flag.String("listen", "127.0.0.1:4187", "Loopback HTTP address")
	secure := flag.Bool("tls", false, "Use verified TLS for Valkey")
	limit := flag.Int("sample", 24000, "Maximum rendered keys, divided across primaries; bounds browser and scan work")
	flag.Parse()
	host, _, err := net.SplitHostPort(*listen)
	if err != nil || (host != "localhost" && (net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback())) {
		log.Fatal("-listen must be a loopback address")
	}
	if *limit < 1 {
		log.Fatal("-sample must be positive")
	}
	c := &Collector{Address: *address, TLS: *secure, Limit: *limit}
	server := &http.Server{Addr: *listen, Handler: handler(c), ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 30 * time.Second}
	log.Printf("Valkey Grove: http://%s (cluster %s)", *listen, *address)
	log.Fatal(server.ListenAndServe())
}
